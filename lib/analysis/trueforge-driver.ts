import { randomBytes, randomUUID } from "node:crypto";

import {
  agentSession,
  agentSessionClaim,
  and,
  connectedRepository,
  db,
  eq,
  githubInstallation,
  report,
  targetProfile,
} from "@/lib/db";
import type { AnalysisContext, AnalysisDriver } from "@/lib/jobs/worker";
import { provisionTarget, teardownSandbox } from "@/lib/sandbox/provision";
import { profileAppPort } from "@/lib/targets/authorize-reproduction";
import { hasActiveRepositoryGrant, type RepositoryGrantSnapshot } from "@/lib/targets/repository-grant";
import { targetProvisioningFromConfig } from "@/lib/targets/registry";
import { createTrueForgeClient, type TrueForgeClient } from "@/lib/trueforge/client";

const SESSION_CREATION_POLL_MS = 100;

type BoundTarget = {
  name: string;
  imageName: string;
  imageDigest: string;
  snapshotId: string | null;
};

/**
 * Describes the report and, when one is authorized, the target the agent may investigate
 * against. Neither the outcome nor the summary is decided here anymore -- the agent reaches
 * its own conclusion and states it through publish_verdict's outcome/summary/findings, which
 * persistAgentDraftedVerdict (lib/mcp/publish-verdict.ts) re-checks against this same
 * authorization before it ever becomes a verdict row.
 */
/**
 * `provisioned` is only meaningful when `target` is non-null: it says whether provisionTarget
 * (called in run(), before the turn message is even built) actually produced a reachable
 * sandbox for this run. A target can be authorized and still unprovisioned -- Daytona down, a
 * bad snapshot, no port configured -- and that failure must never block the report from getting
 * a turn at all, so the agent is told plainly and pointed at ANALYSIS_ONLY, same as having no
 * target bound in the first place.
 */
function buildTurnMessage(
  title: string,
  body: string,
  capabilityToken: string,
  target: BoundTarget | null,
  provisioned: boolean,
): string {
  const pinnedAt = (t: BoundTarget) =>
    `${t.name}, pinned at image ${t.imageName}@${t.imageDigest}${t.snapshotId ? ` (snapshot ${t.snapshotId})` : ""}`;

  const targetSection = !target
    ? `No authorized target is bound to this report -- either no target profile is attached, or the connected repository's grant is inactive or revoked. There is nothing to reproduce against. Draft an ANALYSIS_ONLY verdict from the report text alone; do not claim REPRODUCED or NOT_REPRODUCED here.`
    : provisioned
      ? `This report is bound to an authorized target: ${pinnedAt(target)}. A sandbox running it has already been provisioned for you. Reach it exclusively through probe_target (GET/HEAD) and probe_target_write (POST): give either a method, a same-origin path, and optional headers/body, and it forwards the request to your sandbox -- you never need, and never get, a raw URL, host or token. probe_target_write pauses for human approval before it reaches you, same as any other gated tool; just call it. Use scope-guard, skills and subagents alongside it, then decide the outcome yourself.`
      : `This report is bound to an authorized target: ${pinnedAt(target)}. Its sandbox could not be provisioned this run, so there is nothing reachable to investigate. Draft an ANALYSIS_ONLY verdict from the report text alone; do not claim REPRODUCED or NOT_REPRODUCED here.`;

  return `A bug bounty report has come in for triage.

Title: ${title}

Body:
${body}

${targetSection}

When you are done, call publish_verdict with capability set to exactly this string:
${capabilityToken}
along with your own outcome, summary, and findings. Do not invent a capability value; use only
the one given here. A human reviews the exact drafted text before anything is delivered.`;
}

async function agentSessionExists(reportId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: agentSession.id })
    .from(agentSession)
    .where(eq(agentSession.reportId, reportId))
    .limit(1);
  return existing !== undefined;
}

async function claimAgentSessionCreation(
  reportId: string,
  claimToken: string,
): Promise<"claimed" | "session-created" | "busy"> {
  return db.transaction(async (tx) => {
    await tx.select({ id: report.id }).from(report).where(eq(report.id, reportId)).for("update");

    const [existing] = await tx
      .select({ id: agentSession.id })
      .from(agentSession)
      .where(eq(agentSession.reportId, reportId))
      .limit(1);
    if (existing) return "session-created";

    const rows = await tx
      .insert(agentSessionClaim)
      .values({ reportId, claimToken })
      .onConflictDoNothing({ target: agentSessionClaim.reportId })
      .returning({ reportId: agentSessionClaim.reportId });
    return rows.length > 0 ? "claimed" : "busy";
  });
}

async function agentSessionCreationClaim(reportId: string): Promise<{ claimToken: string } | null> {
  const [claim] = await db
    .select({ claimToken: agentSessionClaim.claimToken })
    .from(agentSessionClaim)
    .where(eq(agentSessionClaim.reportId, reportId))
    .limit(1);
  return claim ?? null;
}

async function releaseAgentSessionCreationClaim(reportId: string, claimToken: string): Promise<void> {
  await db
    .delete(agentSessionClaim)
    .where(
      and(
        eq(agentSessionClaim.reportId, reportId),
        eq(agentSessionClaim.claimToken, claimToken),
      ),
    );
}

async function waitForClaimedAgentSession(reportId: string, signal: AbortSignal): Promise<"session-created" | "claim-open"> {
  for (;;) {
    if (signal.aborted) throw signal.reason;
    if (await agentSessionExists(reportId)) return "session-created";
    const claim = await agentSessionCreationClaim(reportId);
    if (!claim) return "claim-open";
    await new Promise((resolve) => setTimeout(resolve, SESSION_CREATION_POLL_MS));
  }
}

/**
 * The real driver: opens a TrueForge session per report and starts a turn that asks the model
 * to investigate and call publish_verdict. Unlike stubAnalysisDriver, this never transitions
 * the report's lifecycle state, and unlike the pipeline this replaces, it never decides or
 * persists a verdict either -- that transition happens only once a separate poller has
 * independently confirmed, by asking TrueForge itself, that a genuine pending publish_verdict
 * call exists (lib/agent-sessions/poller.ts), and the verdict row it approves is the agent's
 * own drafted conclusion (lib/mcp/publish-verdict.ts), re-authorized against the same
 * target/grant check this file used to run up front. This driver's job stops at: session
 * exists, a turn has started, the agent has what it needs to investigate.
 */
export function createTrueforgeAnalysisDriver(
  client: TrueForgeClient = createTrueForgeClient(),
  provision: typeof provisionTarget = provisionTarget,
): AnalysisDriver {
  return {
    async ensureSession({ reportId, signal }: AnalysisContext): Promise<void> {
      if (signal.aborted) throw signal.reason;

      if (await agentSessionExists(reportId)) return;

      if (signal.aborted) throw signal.reason;

      let claimToken = randomUUID();
      for (;;) {
        const claimResult = await claimAgentSessionCreation(reportId, claimToken);
        if (claimResult === "session-created") return;
        if (claimResult === "claimed") break;
        const waitResult = await waitForClaimedAgentSession(reportId, signal);
        if (waitResult === "session-created") return;
        claimToken = randomUUID();
      }

      if (!client.deleteSession) {
        await releaseAgentSessionCreationClaim(reportId, claimToken);
        throw new Error(`cannot create TrueForge session for report ${reportId} without deleteSession support`);
      }

      let sessionId: string;
      try {
        ({ sessionId } = await client.createSession({ signal }));
      } catch (error) {
        await releaseAgentSessionCreationClaim(reportId, claimToken);
        throw error;
      }

      try {
        await db.transaction(async (tx) => {
          await tx.select({ id: report.id }).from(report).where(eq(report.id, reportId)).for("update");

          const [existingAfterLock] = await tx
            .select({ id: agentSession.id })
            .from(agentSession)
            .where(eq(agentSession.reportId, reportId))
            .limit(1);
          if (existingAfterLock) {
            await tx
              .delete(agentSessionClaim)
              .where(
                and(
                  eq(agentSessionClaim.reportId, reportId),
                  eq(agentSessionClaim.claimToken, claimToken),
                ),
            );
            return;
          }

          const [currentClaim] = await tx
            .select({ claimToken: agentSessionClaim.claimToken })
            .from(agentSessionClaim)
            .where(eq(agentSessionClaim.reportId, reportId))
            .for("update")
            .limit(1);
          if (currentClaim?.claimToken !== claimToken) {
            throw new Error(`agent session creation claim for report ${reportId} changed before persistence`);
          }

          // Opaque handle the model echoes back as publish_verdict's sole identifying argument;
          // the only report identifier it ever sees.
          const capabilityToken = randomBytes(32).toString("base64url");

          // onConflictDoNothing is now belt-and-suspenders rather than the primary defense:
          // the claim row above already keeps two concurrent first-time callers from racing
          // this far together. It still matters for the retry case above, where a differently
          // timed crash could leave two attempts both reaching this insert.
          await tx
            .insert(agentSession)
            .values({ reportId, capabilityToken, sessionId })
            .onConflictDoNothing({ target: agentSession.reportId });
          await tx
            .delete(agentSessionClaim)
            .where(
              and(
                eq(agentSessionClaim.reportId, reportId),
                eq(agentSessionClaim.claimToken, claimToken),
              ),
            );
        });
      } catch (error) {
        await client.deleteSession(sessionId);
        await releaseAgentSessionCreationClaim(reportId, claimToken);
        throw error;
      }
    },

    async run({ reportId, signal }: AnalysisContext): Promise<void> {
      if (signal.aborted) throw signal.reason;

      const [context] = await db
        .select({
          title: report.title,
          body: report.body,
          targetProfileId: report.targetProfileId,
          targetName: targetProfile.name,
          targetImageName: targetProfile.imageName,
          targetImageDigest: targetProfile.imageDigest,
          targetSnapshotId: targetProfile.snapshotId,
          targetConfig: targetProfile.config,
          connectedRepositoryId: report.connectedRepositoryId,
          repoActive: connectedRepository.active,
          repoArchivedAt: connectedRepository.archivedAt,
          repoTargetProfileId: connectedRepository.targetProfileId,
          installationSuspendedAt: githubInstallation.suspendedAt,
          installationDeletedAt: githubInstallation.deletedAt,
        })
        .from(report)
        .leftJoin(targetProfile, eq(report.targetProfileId, targetProfile.id))
        .leftJoin(connectedRepository, eq(report.connectedRepositoryId, connectedRepository.id))
        .leftJoin(githubInstallation, eq(connectedRepository.installationId, githubInstallation.id))
        .where(eq(report.id, reportId))
        .limit(1);
      if (!context) {
        throw new Error(`trueforgeAnalysisDriver.run: report ${reportId} does not exist`);
      }

      // This mirrors persistAgentDraftedVerdict's own re-check (lib/mcp/publish-verdict.ts):
      // describing a target here is advisory context for the agent's investigation, not a
      // grant of authority, so it has to agree with the check that actually gates a
      // REPRODUCED/NOT_REPRODUCED draft or the turn message would promise access the agent's
      // eventual publish_verdict call can't actually use.
      const grantSnapshot: RepositoryGrantSnapshot | null = context.targetProfileId
        ? {
            targetProfileId: context.targetProfileId,
            connectedRepositoryId: context.connectedRepositoryId,
            repoActive: context.repoActive,
            repoArchivedAt: context.repoArchivedAt,
            repoTargetProfileId: context.repoTargetProfileId,
            installationSuspendedAt: context.installationSuspendedAt,
            installationDeletedAt: context.installationDeletedAt,
          }
        : null;
      const targetInfo: BoundTarget | null =
        grantSnapshot && context.targetImageName && hasActiveRepositoryGrant(grantSnapshot)
          ? {
              name: context.targetName as string,
              imageName: context.targetImageName,
              imageDigest: context.targetImageDigest as string,
              snapshotId: context.targetSnapshotId,
            }
          : null;

      // Provisioning is a slow, failure-prone network call (boot a sandbox, wait for the app to
      // answer its own port) and must not run inside the row lock below: AGENTS.md's own design
      // record is explicit that holding a Postgres row lock across it would pay a cost the
      // existing code never had to pay for anything this slow. A cheap, unlocked pre-check
      // first: a turn already exists (a retry, or the loser of a concurrent race below) means
      // this report was already provisioned once, so there's nothing to redo -- provisioning
      // again here would boot a second sandbox nobody would ever store a reference to.
      let provisioned: { sandboxId: string; appPort: number } | null = null;
      if (targetInfo && targetInfo.snapshotId) {
        const [existing] = await db
          .select({ turnId: agentSession.turnId })
          .from(agentSession)
          .where(eq(agentSession.reportId, reportId))
          .limit(1);

        if (existing && !existing.turnId) {
          const appPort = profileAppPort(context.targetConfig);
          const provisioning = targetProvisioningFromConfig(
            targetInfo.name,
            context.targetConfig,
          );
          if (appPort !== null && provisioning) {
            try {
              provisioned = await provision(
                {
                  imageName: targetInfo.imageName,
                  imageDigest: targetInfo.imageDigest,
                  snapshotId: targetInfo.snapshotId,
                  targetProfileId: context.targetProfileId as string,
                  ...provisioning,
                },
                appPort,
                { signal },
              );
            } catch {
              // A genuine cancellation must still propagate as one, not be swallowed into "no
              // target this run" -- the caller's lease/retry semantics depend on seeing it.
              if (signal.aborted) throw signal.reason;
              provisioned = null;
            }
          }
        }
      }

      // The row lock spans the createTurn call on purpose, unlike the delivery worker's GitHub
      // calls: TrueForge is a loopback service this deployment always controls, not a slow or
      // rate-limited external API, so holding one Postgres row lock for the length of one local
      // call is a bounded, acceptable cost for what it buys. Without it, two concurrent run()
      // attempts (or a stale worker still executing after its lease expired, racing a fresh
      // retry) could both pass the "no turnId yet" check, both call createTurn, and both try to
      // write: TrueForge chains a new turn onto the session's last turn by default, so a second
      // concurrent createTurn call does not just waste an API call, it cancels the first turn
      // outright. Serializing on this row means the second attempt always sees the first
      // attempt's committed turnId and returns without ever calling createTurn.
      //
      // Residual, accepted gap: if a transaction crashes after TrueForge accepts a turn but
      // before the write below commits, that turn is orphaned. The next retry creates a new
      // one, which supersedes it via the same session-chaining behavior, at the cost of one
      // wasted call. Same category as ensureSession's accepted orphaned-session cost above.
      //
      // A provisioned-but-not-yet-persisted sandbox is a different kind of orphan: nothing
      // durable points at it yet, so neither this driver's own retry nor the poller's teardown
      // paths (lib/agent-sessions/poller.ts) can ever find it again once this call returns.
      // lostRace and the outer try/catch exist for exactly that window -- losing the race,
      // cancellation, a createTurn failure, or any other error thrown before the write below
      // commits -- and tear the sandbox down once the transaction is no longer open. Teardown
      // is a Daytona network call and never runs while this transaction still holds the
      // agent_session row locked: a slow delete blocking every other update to that row for its
      // duration would be its own new cost, not a cleanup.
      let lostRace = false;
      try {
        await db.transaction(async (tx) => {
          const [session] = await tx
            .select({
              id: agentSession.id,
              sessionId: agentSession.sessionId,
              turnId: agentSession.turnId,
              capabilityToken: agentSession.capabilityToken,
            })
            .from(agentSession)
            .where(eq(agentSession.reportId, reportId))
            .for("update");

          if (!session) {
            throw new Error(
              `trueforgeAnalysisDriver.run: no agent session for report ${reportId}; ensureSession must run first`,
            );
          }

          // A turn was already started for this report, either by an earlier pass or by
          // whichever concurrent caller won the lock first. The poller takes it from here
          // regardless of how that turn is doing. If this losing attempt already provisioned a
          // sandbox before losing the race, it's this attempt's own to clean up -- nothing else
          // ever learns its id, since only the winner's write below persists one onto the row.
          // The teardown itself waits until after this transaction commits (see lostRace below).
          if (session.turnId) {
            lostRace = true;
            return;
          }

          if (signal.aborted) throw signal.reason;

          const content = buildTurnMessage(
            context.title,
            context.body,
            session.capabilityToken,
            targetInfo,
            provisioned !== null,
          );
          const { turnId } = await client.createTurn(
            session.sessionId,
            [{ type: "user.message", content }],
            { signal },
          );

          // RUNNING means the turn just started and the agent hasn't called anything yet; the
          // poller (lib/agent-sessions/poller.ts) promotes this to INVESTIGATING once it has
          // actually observed the turn still going on a later poll.
          await tx
            .update(agentSession)
            .set({
              turnId,
              turnStatus: "RUNNING",
              sandboxId: provisioned?.sandboxId ?? null,
              appPort: provisioned?.appPort ?? null,
              updatedAt: new Date(),
            })
            .where(eq(agentSession.id, session.id));
        });
      } catch (error) {
        if (provisioned) await teardownSandbox(provisioned.sandboxId, true);
        throw error;
      }
      if (lostRace && provisioned) await teardownSandbox(provisioned.sandboxId, true);

      if (signal.aborted) throw signal.reason;
    },
  };
}

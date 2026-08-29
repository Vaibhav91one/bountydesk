import { randomUUID } from "node:crypto";

import {
  agentSession,
  and,
  connectedRepository,
  db,
  eq,
  githubInstallation,
  isNull,
  report,
  targetProfile,
} from "@/lib/db";
import { recordEvent } from "@/lib/reports/lifecycle";
import type { ReportState } from "@/lib/reports/states";
import { ensureInitialVerdict } from "@/lib/verdicts/lifecycle";

/**
 * Fill a local database with reports across the lifecycle, so the board and the case file have
 * something to render.
 *
 * Development and demo rehearsal only.
 *
 *   npm run seed:reports
 *
 * It refuses to run against anything but localhost, and that refusal matters more here than in
 * the other scripts: verdict, approval_decision, session_event and delivery_attempt all reject
 * UPDATE and DELETE through triggers, so rows this writes cannot be taken back out. Pointing it
 * at the shared project would permanently mix invented reports into real ones.
 *
 * Every run appends. It is not idempotent, because source_ref carries a fresh issue number each
 * time; run it once against an empty database rather than repeatedly.
 */

function assertLocal(): void {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error(
      `refusing to seed ${host}: this writes rows that cannot be deleted, so it only runs against a local database`,
    );
  }
}

/** The demo target, per Q18. Created if this database has never had one. */
async function ensureTarget(): Promise<string> {
  const [existing] = await db
    .select({ id: targetProfile.id })
    .from(targetProfile)
    .where(eq(targetProfile.name, "juice-shop-v17.3.0"));

  if (existing) return existing.id;

  const [created] = await db
    .insert(targetProfile)
    .values({
      name: "juice-shop-v17.3.0",
      // A placeholder digest. Nothing reproduces from seeded data, and a real-looking digest
      // here would be a claim that an artifact was built and verified.
      imageDigest: `sha256:${"0".repeat(64)}`,
    })
    .returning({ id: targetProfile.id });

  return created.id;
}

/** A repository to hang the reports off, so the case file has an intake source to name. */
async function ensureRepository(targetProfileId: string): Promise<string> {
  const [existingRepo] = await db
    .select({ id: connectedRepository.id })
    .from(connectedRepository)
    .where(eq(connectedRepository.fullName, "Vaibhav91one/juice-shop"));

  if (existingRepo) return existingRepo.id;

  // Reuse this account's installation if the database already has one. There is no unique
  // constraint on account_login, so always inserting a fixed installation_id gave a local
  // database two rows for the same account, and the Integrations screen honestly reported both.
  //
  // Bound to the demo account and to a live installation on purpose. Any live one would attach
  // Vaibhav91one/juice-shop to whatever account happened to be first, and a suspended one would
  // seed a repository that intake and delivery both refuse at runtime, so the approval path
  // this script exists to demonstrate would fail at the last step.
  const [existingInstallation] = await db
    .select({ id: githubInstallation.id })
    .from(githubInstallation)
    .where(
      and(
        eq(githubInstallation.accountLogin, "Vaibhav91one"),
        isNull(githubInstallation.deletedAt),
        isNull(githubInstallation.suspendedAt),
      ),
    )
    .limit(1);

  const installationRowId =
    existingInstallation?.id ??
    (
      await db
        .insert(githubInstallation)
        .values({
          installationId: 99_000_001,
          accountLogin: "Vaibhav91one",
          accountId: 108_279_746,
          accountType: "User",
        })
        .returning({ id: githubInstallation.id })
    )[0].id;

  const [created] = await db
    .insert(connectedRepository)
    .values({
      installationId: installationRowId,
      repoId: 99_100_001,
      fullName: "Vaibhav91one/juice-shop",
      targetProfileId,
    })
    .returning({ id: connectedRepository.id });

  return created.id;
}

type Seed = {
  state: ReportState;
  title: string;
  events: string[];
  /** Reports that never reached a target, to exercise the "none bound" card. */
  unbound?: boolean;
};

/**
 * The event names are the ones the code actually writes today: intake.accepted from the jobs
 * worker, analysis.* from the analysis drivers. The sandbox events the wireframe shows
 * (image.boot, canary.seed, poc.run, oracle.observe) are not seeded, because nothing emits
 * them and a timeline that showed them would be describing a reproduction that never ran.
 */
const SEEDS: Seed[] = [
  {
    state: "TRIAGING",
    title: "Stored XSS in the product review field",
    events: ["intake.accepted"],
  },
  {
    state: "REPRODUCING",
    title: "SQL injection in /rest/products/search",
    events: ["intake.accepted", "analysis.stub_session.created"],
  },
  {
    state: "ANALYSIS_ONLY",
    title: "Weak JWT signing key on the login endpoint",
    events: ["intake.accepted", "analysis.stub_session.created", "analysis.completed"],
    unbound: true,
  },
  {
    state: "DELIVERED",
    title: "Directory traversal in the file upload handler",
    events: ["intake.accepted", "analysis.stub_session.created", "analysis.completed"],
  },
  {
    state: "OUT_OF_SCOPE",
    title: "Missing security headers on the marketing site",
    events: ["intake.accepted"],
  },
];

/** The one report a reviewer can actually act on: a pending call bound to a real hash. */
const AWAITING: Seed = {
  state: "AWAITING_APPROVAL",
  title: "Auth bypass via SQL injection on login",
  events: ["intake.accepted", "analysis.stub_session.created", "analysis.completed"],
};

/**
 * The comment a reviewer would be signing.
 *
 * The delivery marker carries the verdict id, so the id has to exist before the text does.
 * The delivery worker refuses any payload that does not contain its marker exactly once, which
 * would have left a seeded verdict approvable but permanently undeliverable.
 */
function payloadFor(verdictId: string): string {
  return `**Verdict: analysis only**

BountyDesk could not reproduce this report automatically, so no reproduced verdict was
produced. A reviewer read the report and the run's own event log and is signing this reply by
hand.

Signed via BountyDesk.
<!-- bountydesk-delivery:${verdictId} -->`;
}

async function main(): Promise<void> {
  assertLocal();

  const targetProfileId = await ensureTarget();
  const connectedRepositoryId = await ensureRepository(targetProfileId);
  const stamp = Date.now();
  let issue = 0;

  async function create(seed: Seed): Promise<string> {
    issue += 1;
    const [row] = await db
      .insert(report)
      .values({
        channel: "github",
        sourceRef: `github:99100001:issue:${stamp % 100000}${issue}`,
        title: seed.title,
        body: `Seeded report. ${seed.title}.`,
        // A real login so the avatar resolves. Seeded reports are fake; the handle is not.
        reporterHandle: "Vaibhav91one",
        state: seed.state,
        connectedRepositoryId,
        targetProfileId: seed.unbound ? null : targetProfileId,
      })
      .returning({ id: report.id });

    for (const type of seed.events) await recordEvent(row.id, type, { seeded: true });
    return row.id;
  }

  for (const seed of SEEDS) await create(seed);

  const awaitingId = await create(AWAITING);
  const verdictId = randomUUID();
  // The real factory, not a hand-built insert: it is what enforces the delivery marker and
  // computes the hash from the exact bytes, and a seed that skipped it would produce a verdict
  // the rest of the system refuses.
  const pending = await ensureInitialVerdict({
    id: verdictId,
    reportId: awaitingId,
    outcome: "ANALYSIS_ONLY",
    summary: "Reproduction did not run. A reviewer decides.",
    evidence: { reason: "AUTOMATED_REPRODUCTION_NOT_RUN" },
    payload: payloadFor(verdictId),
  });

  await db.insert(agentSession).values({
    reportId: awaitingId,
    capabilityToken: randomUUID(),
    sessionId: `seeded-session-${stamp}`,
    turnStatus: "AWAITING_APPROVAL_HARNESS",
    pendingThreadId: `seeded-thread-${stamp}`,
    pendingToolCallId: `seeded-call-${stamp}`,
    pendingVerdictId: pending.id,
    pendingApprovedContentHash: pending.contentHash,
  });

  console.log(`seeded ${SEEDS.length + 1} reports, one awaiting approval (${awaitingId})`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

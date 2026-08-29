import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "@phosphor-icons/react/ssr";

import { PhaseDot } from "@/components/phase-dot";
import { SandboxDiagram, type NodeStatus } from "@/components/sandbox-diagram";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { requireReviewer } from "@/lib/auth/dal";
import { formatStamp } from "@/lib/format";
import { isReportId, oracleDecided, readCase, type CaseFile } from "@/lib/reports/case";
import { mascotState } from "@/lib/mascot/states";
import { phaseOf } from "@/lib/reports/queue";

import { ApprovalDialog } from "./approval-dialog";
import { ArtifactsPanel, verdictArtifacts } from "./artifacts-panel";
import { VerdictCard } from "./verdict-card";
import { LifecycleList, type LifecycleStep } from "./lifecycle-list";
import type { StepState } from "./lifecycle-step";
import { StatusCard } from "./status-card";

export const metadata = { title: "Case file · BountyDesk" };

const STATE_LABEL: Record<string, string> = {
  TRIAGING: "Triaging",
  REPRODUCING: "Reproducing",
  ANALYSIS_ONLY: "Analysis only",
  AWAITING_APPROVAL: "Awaiting approval",
  DELIVERING: "Delivering",
  DELIVERED: "Delivered",
  DENIED: "Denied",
  OUT_OF_SCOPE: "Out of scope",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};

const OUTCOME: Record<string, string> = {
  REPRODUCED: "Reproduced",
  NOT_REPRODUCED: "Not reproduced",
  INCONCLUSIVE: "Inconclusive",
  ANALYSIS_ONLY: "Analysis only",
};

function Panel({
  title,
  aside,
  children,
  className,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`flex min-w-0 flex-col gap-4 rounded-xl border border-border/50 bg-card p-5 ${className ?? ""}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-meta text-muted-foreground">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}
/**
 * The pipeline, and how far this report got through it.
 *
 * Derived from state and from what exists, never from a stored step counter: there is no such
 * column, and inventing one that could drift from the report's own state would make the
 * picture and the truth two different things.
 */
/**
 * Which lifecycle step an event belongs to, by the prefix its type carries.
 *
 * Anything unrecognised falls to the step the report is currently in rather than being
 * dropped. An event nobody placed is still an event that happened, and a log that quietly
 * loses lines is worse than one with a line in the wrong place.
 */
const EVENT_PHASE: Record<string, string> = {
  intake: "intake",
  sandbox: "reproduction",
  repro: "reproduction",
  analysis: "verdict",
  verdict: "verdict",
  approval: "approval",
  delivery: "delivery",
  target: "reproduction",
};

/**
 * Which mascot stands for a lifecycle row.
 *
 * Keyed to the row and to what the record says happened in it, so a reproduction that never
 * ran and one that is running do not draw the same picture. Two rows borrow a neighbouring
 * state's artwork because no mascot exists for them yet: drafting a verdict uses scanning, and
 * a signed approval uses canary-found.
 */
function stepMascot(
  key: string,
  state: StepState,
  file: CaseFile,
): Parameters<typeof mascotState>[0] {
  if (key === "intake") return "ingest";
  if (key === "reproduction") {
    return state === "current" ? "reproducing" : state === "skipped" ? "infra-hiccup" : "scanning";
  }
  if (key === "verdict") return "scanning";
  if (key === "approval") {
    return file.approval?.decision === "DENIED" ? "denied" : "awaiting-approval";
  }
  return state === "done" ? "celebrating" : "delivered";
}

function lifecycle(file: CaseFile) {
  const terminal = ["DELIVERED", "DENIED", "OUT_OF_SCOPE", "CANCELLED", "EXPIRED"];
  const past = (states: string[]) => states.includes(file.state);

  return [
    {
      key: "intake",
      label: "Intake",
      note: file.target ? "Authenticated, target bound" : "Authenticated, no target bound",
      state: "done" as const,
    },
    {
      key: "reproduction",
      label: "Reproduction",
      // ANALYSIS_ONLY is precisely the state that means this did not happen.
      note:
        file.state === "ANALYSIS_ONLY"
          ? "Did not run"
          : file.state === "REPRODUCING"
            ? "In progress"
            : "Not built yet",
      state:
        file.state === "REPRODUCING"
          ? ("current" as const)
          : file.state === "TRIAGING"
            ? ("pending" as const)
            : ("skipped" as const),
    },
    {
      key: "verdict",
      label: "Verdict drafted",
      note: file.verdict ? `Revision ${file.verdict.revision}` : "None yet",
      state: file.verdict ? ("done" as const) : ("pending" as const),
    },
    {
      key: "approval",
      label: "Human approval",
      note: file.approval
        ? `${file.approval.decision === "APPROVED" ? "Approved" : "Denied"} by ${file.approval.reviewer}`
        : file.awaitingVerdictId
          ? "Waiting on a reviewer"
          : "Not reached",
      state: file.approval
        ? ("done" as const)
        : past(["AWAITING_APPROVAL"])
          ? ("current" as const)
          : ("pending" as const),
    },
    {
      key: "delivery",
      label: "Delivery",
      note: file.delivery ? file.delivery.state.toLowerCase() : "Not enqueued",
      state:
        file.state === "DELIVERED"
          ? ("done" as const)
          : file.state === "DELIVERING"
            ? ("current" as const)
            : past(terminal)
              ? ("skipped" as const)
              : ("pending" as const),
    },
  ];
}
/**
 * A link out to GitHub, or the same text unlinked.
 *
 * The href is null whenever the destination cannot be built honestly: an email report has no
 * issue, a repository we no longer hold has no owner or name. Rendering an anchor to a URL
 * assembled from half the pieces sends a reviewer somewhere that is not this report.
 */
function External({ href, children }: { href: string | null; children: React.ReactNode }) {
  if (!href) return <span className="text-foreground">{children}</span>;

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-foreground underline-offset-4 hover:text-brand-soft hover:underline"
    >
      {children}
    </a>
  );
}

/** The reporter as an avatar. The handle stays as the label and the tooltip. */
function Reporter({
  handle,
  href,
  avatarUrl,
}: {
  handle: string;
  href: string | null;
  avatarUrl: string | null;
}) {
  const badge = (
    <Avatar className="size-5">
      {/* Loaded from github.com, which is where the reviewer is already authenticated. The
          fallback covers a handle that is not a login and an image that will not load. */}
      {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
      <AvatarFallback className="text-[10px]">
        {handle.slice(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );

  if (!href) {
    return (
      <span className="flex items-center gap-1.5 text-foreground" title={handle}>
        {badge}
        <span className="sr-only">{handle}</span>
      </span>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={handle}
      className="flex items-center gap-1.5 text-foreground hover:text-brand-soft"
    >
      {badge}
      <span className="sr-only">{handle}</span>
    </a>
  );
}


export default async function CaseFilePage({ params }: { params: Promise<{ id: string }> }) {
  await requireReviewer();
  const { id } = await params;

  // A uuid that does not exist and a string that is not a uuid are the same answer to a
  // reviewer, and letting the malformed one reach the database only produces a 500.
  const file = isReportId(id) ? await readCase(id) : null;
  if (!file) notFound();

  const phase = phaseOf(file.state);

  // Events, grouped onto the step they belong to. The fallback step is the one matching the
  // report's own state, so an unknown prefix lands somewhere a reader would look for it.
  const fallback =
    file.state === "TRIAGING"
      ? "intake"
      : file.state === "REPRODUCING"
        ? "reproduction"
        : file.state === "DELIVERING" || file.state === "DELIVERED"
          ? "delivery"
          : "verdict";

  const eventsByStep = new Map<string, LifecycleStep["events"]>();
  for (const event of file.events) {
    const key = EVENT_PHASE[event.channel] ?? fallback;
    const bucket = eventsByStep.get(key) ?? [];
    bucket.push({ seq: event.seq, type: event.type, at: event.at.toISOString().slice(11, 19) });
    eventsByStep.set(key, bucket);
  }

  const steps: LifecycleStep[] = lifecycle(file).map((step) => {
    const mascot = mascotState(stepMascot(step.key, step.state, file));
    return {
      ...step,
      // Two rows can land on the same mascot, and the artwork carries ids. Without a per-row
      // prefix the second copy's gradients resolve against the first one's defs and it draws
      // wrong, which is the same trap status-card.tsx works around.
      mascot: mascot.markup.replaceAll(`${mascot.key}__`, `${mascot.key}__${step.key}__`),
      events: eventsByStep.get(step.key) ?? [],
    };
  });

  /**
   * Which sandbox stages this report can show actually happened.
   *
   * Two, today. The repository resolved to a commit and the controller processed the report,
   * both of which leave rows behind. The target is bound but has never booted, and the build
   * sandbox, PoC runner and oracle have never run at all, so none of them is marked and
   * nothing spins. When reproduction ships and writes its own events, this fills in on its own.
   */
  const artifacts = verdictArtifacts(file.verdict?.evidence);

  // Same id-prefix trap as the lifecycle rows: several mascots share one page.
  const prefixed = (key: Parameters<typeof mascotState>[0], slot: string) => {
    const mascot = mascotState(key);
    return mascot.markup.replaceAll(`${mascot.key}__`, `${mascot.key}__${slot}__`);
  };

  const nodeStatus: Record<string, NodeStatus> = {
    repo: file.repositoryFullName ? "done" : "idle",
    controller: file.events.length > 0 ? "done" : "idle",
    build: file.events.some((e) => e.channel === "sandbox") ? "done" : "idle",
    target: file.state === "REPRODUCING" ? "running" : "idle",
    poc: file.events.some((e) => e.channel === "repro") ? "done" : "idle",
    // Only a recorded oracle result marks the oracle. A tick here would say a canary was
    // observed, which is the one claim the UI must never make on the model's behalf.
    oracle: file.verdict && oracleDecided(file.verdict.evidence) ? "done" : "idle",
  };

  /**
   * Whose verdict this is.
   *
   * Agent Bounty drafts it today, because reproduction is not built and no oracle has ever
   * run: verdict.evidence says as much, in the one reason string it carries. The moment an
   * oracle does decide, this stops being Agent Bounty's to claim. The invariant is that the
   * verdict comes from the canary and the model never narrates it, so the label is derived
   * rather than written down, and it changes by itself when the evidence changes.
   */
  // Fail closed: only a recorded oracle result earns the oracle's name on the label. Anything
  // else, including evidence nobody recognises, is Agent Bounty speaking for itself.
  const drafted = !file.verdict || !oracleDecided(file.verdict.evidence);
  const verdictLabel = drafted ? "Agent Bounty says" : "The oracle says";

  return (
    <main className="flex flex-1 flex-col">
      <header className="flex flex-col gap-4 border-b border-border/50 px-8 py-7">
        <Link
          href="/board"
          className="flex w-fit items-center gap-2 text-meta text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Review queue
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            {/* GitHub's shape: the title, then its number in the same line at lower
                contrast. The number is part of the identity, not a separate field. */}
            <h1 className="text-title text-foreground">
              {file.title}
              {file.issueNumber ? (
                <span className="ml-2 font-normal text-muted-foreground">
                  #{file.issueNumber}
                </span>
              ) : null}
            </h1>

            <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-meta text-muted-foreground">
              <span className="flex items-center gap-2 text-body text-foreground">
                <PhaseDot phase={phase} />
                {STATE_LABEL[file.state] ?? file.state}
              </span>

              <span aria-hidden="true">·</span>

              {file.reporterHandle ? (
                <>
                  {/* The avatar stands in for the name, so the name has to survive somewhere
                      a screen reader and a hover can both reach it. */}
                  <Reporter
                    handle={file.reporterHandle}
                    href={file.reporterUrl}
                    avatarUrl={file.reporterAvatarUrl}
                  />
                  <span>opened</span>
                </>
              ) : null}

              <External href={file.issueUrl}>{file.sourceLabel}</External>

              {file.repositoryFullName ? (
                <>
                  <span>in</span>
                  <External href={file.repositoryUrl}>{file.repositoryFullName}</External>
                </>
              ) : null}
            </p>
          </div>

          {/* Only where there is a pending call an approval could answer. A report sitting in
              AWAITING_APPROVAL with nothing pending would open a dialog whose buttons refuse. */}
          {file.awaitingVerdictId && file.verdict ? (
            <ApprovalDialog
              reportId={file.id}
              verdictId={file.awaitingVerdictId}
              contentHash={file.verdict.contentHash}
              payload={file.verdict.payload}
              outcome={file.verdict.outcome}
              outcomeLabel={OUTCOME[file.verdict.outcome] ?? file.verdict.outcome}
              summary={file.verdict.summary}
              revision={file.verdict.revision}
              destination={file.delivery?.target ?? file.issueUrl ?? file.sourceLabel}
              targetName={file.target?.name ?? null}
              reproductionRan={!drafted}
              speaker={prefixed("awaiting-approval", "speaker")}
              chatMascot={prefixed("greeting", "chat")}
              events={file.events.map((event) => ({
                seq: event.seq,
                type: event.type,
                at: event.at.toISOString().slice(11, 19),
              }))}
            />
          ) : null}
        </div>
      </header>

      <div className="flex flex-col gap-4 p-8">
        <StatusCard
          file={file}
          stateLabel={STATE_LABEL[file.state] ?? file.state}
          verdictLabel={verdictLabel}
          outcomeLabel={
            file.verdict ? (OUTCOME[file.verdict.outcome] ?? file.verdict.outcome) : null
          }
        />

        {/* The pipeline beside the shape it runs through. Equal height on purpose: they are
            two views of the same run, and one of them ending early reads as unfinished. */}
        <div className="grid items-stretch gap-4 lg:grid-cols-2">
          <Panel title="Lifecycle" className="p-0">
            <LifecycleList steps={steps} />
          </Panel>

          <Panel title="Sandbox architecture" aside={<Badge variant="outline">Not run</Badge>}>
            <SandboxDiagram targetName={file.target?.name ?? null} status={nodeStatus} />
          </Panel>
        </div>

        {/* Once the gate has closed there is no dialog to open, and the comment that went out
            would otherwise be nowhere on this page. The same card, with the decision in place
            of the buttons. */}
        {file.verdict && !file.awaitingVerdictId ? (
          <VerdictCard
            payload={file.verdict.payload}
            outcome={file.verdict.outcome}
            outcomeLabel={OUTCOME[file.verdict.outcome] ?? file.verdict.outcome}
            revision={file.verdict.revision}
            contentHash={file.verdict.contentHash}
            destination={file.delivery?.target ?? file.issueUrl ?? file.sourceLabel}
            speaker={prefixed("awaiting-approval", "record")}
            chatMascot={prefixed("greeting", "record-chat")}
            decision={
              file.approval
                ? {
                    decision: file.approval.decision,
                    reviewer: file.approval.reviewer,
                    note: file.approval.note,
                    at: formatStamp(file.approval.decidedAt),
                  }
                : null
            }
          />
        ) : null}

        <Panel
          title="Artifacts"
          aside={
            <Badge variant="outline">
              {artifacts.length === 0 ? "None produced" : `${artifacts.length} recorded`}
            </Badge>
          }
        >
          <ArtifactsPanel
            artifacts={artifacts}
            imageDigest={file.target?.imageDigest || null}
            contentHash={file.verdict?.contentHash ?? null}
          />
        </Panel>
      </div>
    </main>
  );
}

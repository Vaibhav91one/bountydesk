import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "@phosphor-icons/react/ssr";

import { PhaseDot } from "@/components/phase-dot";
import { SandboxDiagram, type NodeStatus } from "@/components/sandbox-diagram";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { requireReviewer } from "@/lib/auth/dal";
import { readCase, type CaseEvent, type CaseFile } from "@/lib/reports/case";
import { phaseOf } from "@/lib/reports/queue";

import { LifecycleList, type LifecycleStep } from "./lifecycle-list";
import { StatusCard } from "./status-card";
import { SignVerdict } from "./sign-verdict";

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
        <h2 className="text-label tracking-normal text-muted-foreground">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}


function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-6 gap-y-1 border-b border-border/50 py-2.5 last:border-b-0">
      <span className="shrink-0 text-meta text-muted-foreground">{label}</span>
      {/* A digest and a JSON blob are single unbreakable tokens, and without break-all they
          set the row's minimum width and push the whole panel past a phone viewport. */}
      <span className="min-w-0 break-all text-body text-foreground">{children}</span>
    </div>
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


function EventRow({ event }: { event: CaseEvent }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-border/50 py-2.5 last:border-b-0">
      <time
        dateTime={event.at.toISOString()}
        className="w-20 shrink-0 font-mono text-meta text-muted-foreground"
      >
        {event.at.toISOString().slice(11, 19)}
      </time>
      <Badge variant="outline" className="shrink-0 font-mono">
        {event.channel}
      </Badge>
      <span className="text-body text-foreground">{event.type}</span>
    </li>
  );
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
  const looksLikeId = /^[0-9a-f-]{36}$/i.test(id);
  const file = looksLikeId ? await readCase(id) : null;
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

  const steps: LifecycleStep[] = lifecycle(file).map((step) => ({
    ...step,
    events: eventsByStep.get(step.key) ?? [],
  }));

  /**
   * Which sandbox stages this report can show actually happened.
   *
   * Two, today. The repository resolved to a commit and the controller processed the report,
   * both of which leave rows behind. The target is bound but has never booted, and the build
   * sandbox, PoC runner and oracle have never run at all, so none of them is marked and
   * nothing spins. When reproduction ships and writes its own events, this fills in on its own.
   */
  const nodeStatus: Record<string, NodeStatus> = {
    repo: file.repositoryFullName ? "done" : "idle",
    controller: file.events.length > 0 ? "done" : "idle",
    build: file.events.some((e) => e.channel === "sandbox") ? "done" : "idle",
    target: file.state === "REPRODUCING" ? "running" : "idle",
    poc: file.events.some((e) => e.channel === "repro") ? "done" : "idle",
    // Only an oracle result marks the oracle. The reason string every verdict carries today
    // says the opposite in as many words.
    oracle:
      file.verdict &&
      (file.verdict.evidence as { reason?: string } | null)?.reason !==
        "AUTOMATED_REPRODUCTION_NOT_RUN"
        ? "done"
        : "idle",
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
  const drafted =
    !file.verdict ||
    (file.verdict.evidence as { reason?: string } | null)?.reason ===
      "AUTOMATED_REPRODUCTION_NOT_RUN";
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
          <div className="flex min-w-0 flex-col gap-2.5">
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

        <div>
          <Panel title="Reporter input">
            {/* The reporter's own words, rendered as plain text. Never as markdown or HTML:
                this is attacker-controlled input, and the whole product treats it as data. */}
            <pre className="max-h-80 overflow-auto rounded-md bg-background p-4 text-body whitespace-pre-wrap text-foreground">
              {file.body}
            </pre>
            <p className="text-meta text-muted-foreground">
              Reporter text and any proof of concept in it stay untrusted hints. Nothing here
              decides the verdict.
            </p>
          </Panel>

        </div>

        <div>
          {/* Reproduction is not built, so there is no canary, no negative control and no
              oracle result to weigh. The panel keeps its place and says that, rather than
              leaving a gap that reads like a value which failed to load. The topology it used
              to describe is the diagram at the top of the page. */}
          <Panel title="Evidence and analysis" aside={<Badge variant="outline">Not run</Badge>}>
            <p className="text-body text-muted-foreground">
              No canary was seeded, no negative control ran and no oracle was consulted, so
              there is no evidence to weigh. When reproduction ships, the verdict comes from
              the oracle observing a fresh canary outside the sandbox, never from the model.
            </p>
            <div className="flex flex-col">
              <Row label="Recorded evidence">
                <span className="font-mono text-meta">
                  {file.verdict ? JSON.stringify(file.verdict.evidence) : "—"}
                </span>
              </Row>
            </div>
          </Panel>
        </div>

        <Panel
          title="Execution log"
          aside={
            <span className="text-meta text-muted-foreground">
              {file.events.length} {file.events.length === 1 ? "event" : "events"}
            </span>
          }
        >
          {file.events.length === 0 ? (
            <p className="text-body text-muted-foreground">Nothing has been recorded yet.</p>
          ) : (
            <ol className="flex flex-col">
              {file.events.map((event) => (
                <EventRow key={event.seq} event={event} />
              ))}
            </ol>
          )}
        </Panel>

        <Panel
          title="Exact outbound verdict"
          aside={
            file.verdict ? (
              <Badge variant="outline">Revision {file.verdict.revision}</Badge>
            ) : null
          }
        >
          {!file.verdict ? (
            <p className="text-body text-muted-foreground">
              No verdict has been drafted. There is nothing to approve.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-heading text-foreground">
                  {OUTCOME[file.verdict.outcome] ?? file.verdict.outcome}
                </span>
                <span className="text-body text-muted-foreground">{file.verdict.summary}</span>
              </div>

              {/* The exact bytes that would be posted. Plain text, never rendered as
                  markdown: a reviewer has to approve what actually goes out. */}
              <pre className="max-h-96 overflow-auto rounded-md bg-background p-4 text-body whitespace-pre-wrap text-foreground">
                {file.verdict.payload}
              </pre>

              {file.approval ? (
                <p className="text-body text-muted-foreground">
                  {file.approval.decision === "APPROVED" ? "Approved" : "Denied"} by{" "}
                  {file.approval.reviewer} on{" "}
                  {file.approval.decidedAt.toISOString().replace("T", " ").slice(0, 16)} UTC.
                  {file.approval.note ? ` Note: ${file.approval.note}` : ""}
                </p>
              ) : file.awaitingVerdictId ? (
                <SignVerdict
                  reportId={file.id}
                  verdictId={file.awaitingVerdictId}
                  contentHash={file.verdict.contentHash}
                />
              ) : (
                <p className="text-body text-muted-foreground">
                  This verdict is not awaiting a decision. Approval only opens while the harness
                  is holding a pending publish_verdict call.
                </p>
              )}
            </>
          )}
        </Panel>
      </div>
    </main>
  );
}

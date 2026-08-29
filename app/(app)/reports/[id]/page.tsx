import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowSquareOut } from "@phosphor-icons/react/ssr";

import { PhaseDot } from "@/components/phase-dot";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireReviewer } from "@/lib/auth/dal";
import { readCase, type CaseEvent, type CaseFile } from "@/lib/reports/case";
import { phaseOf } from "@/lib/reports/queue";

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
        <h2 className="text-label text-muted-foreground uppercase">{title}</h2>
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

const STEP_TONE: Record<string, string> = {
  done: "border-phase-delivered text-phase-delivered",
  current: "border-phase-approval text-phase-approval",
  pending: "border-border/50 text-muted-foreground",
  skipped: "border-border/50 text-muted-foreground",
};

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
  const steps = lifecycle(file);

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
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel
            title="Reporter input"
            className="lg:col-span-2"
            aside={
              file.issueUrl ? (
                <Button
                  size="sm"
                  variant="outline"
                  nativeButton={false}
                  render={<a href={file.issueUrl} target="_blank" rel="noreferrer" />}
                >
                  Open on GitHub <ArrowSquareOut className="size-3.5" />
                </Button>
              ) : null
            }
          >
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

          <Panel title="Current run" aside={<Badge variant="outline">{file.channel}</Badge>}>
            <div className="flex flex-col">
              <Row label="Report">
                <span className="font-mono">{file.id.slice(0, 8)}</span>
              </Row>
              <Row label="Opened">
                <time dateTime={file.createdAt.toISOString()}>
                  {file.createdAt.toISOString().replace("T", " ").slice(0, 16)} UTC
                </time>
              </Row>
              <Row label="Last change">
                <time dateTime={file.updatedAt.toISOString()}>
                  {file.updatedAt.toISOString().replace("T", " ").slice(0, 16)} UTC
                </time>
              </Row>
              <Row label="Bound target">{file.target?.name ?? "none bound"}</Row>
            </div>
          </Panel>
        </div>

        <Panel
          title="Lifecycle"
          aside={
            <span className="text-meta text-muted-foreground">
              Display phases. Stored state: {file.state}.
            </span>
          }
        >
          <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {steps.map((step, index) => (
              <li key={step.key} className="flex flex-col gap-2">
                <span
                  className={`flex size-7 items-center justify-center rounded-full border text-meta ${STEP_TONE[step.state]}`}
                >
                  {step.state === "done" ? "✓" : index + 1}
                </span>
                <span className="text-body font-medium text-foreground">{step.label}</span>
                <span className="text-meta text-muted-foreground">{step.note}</span>
              </li>
            ))}
          </ol>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Both of these panels are empty by design, not by accident. Reproduction is not
              built: there is no sandbox, no canary and no artifact store, so there is nothing
              to render and nothing that may be implied. They keep their place so the shape is
              right when the sandbox lands. */}
          <Panel title="Sandbox and compute" aside={<Badge variant="outline">Not run</Badge>}>
            <p className="text-body text-muted-foreground">
              No sandbox was provisioned for this report. Reproduction is designed and not
              built, so there is no target container, no egress policy and no resource use to
              show.
            </p>
            <div className="flex flex-col">
              <Row label="Bound target">{file.target?.name ?? "none bound"}</Row>
              <Row label="Pinned image">
                <span className="font-mono text-meta">
                  {file.target?.imageDigest ? `${file.target.imageDigest.slice(0, 23)}…` : "—"}
                </span>
              </Row>
            </div>
          </Panel>

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

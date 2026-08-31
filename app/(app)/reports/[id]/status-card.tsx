import { GitHubLight } from "developer-icons";

import { AnimatedMascotSvg } from "@/components/animated-mascot-svg";
import { RollingIcon } from "@/components/rolling-icon";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatStamp } from "@/lib/format";
import type { CaseLiveView } from "@/lib/reports/case-view";

/** One fact. The value is always something the database holds. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-meta text-muted-foreground">{label}</span>
      <span className="truncate text-body text-foreground">{children}</span>
    </div>
  );
}

/**
 * The report at a glance: Agent Bounty in the state the report is in, and the facts beside him.
 *
 * The mascot comes from the shared state map, so he is doing on this page whatever he is doing
 * on the board for the same report. He is decoration in the sense that no decision rests on
 * him, and not decoration in the sense that he is wrong if the state changes and he does not.
 *
 * Every value here reads off the live view, which is the point: this card used to be
 * server-rendered with one live field spliced into it, so the status said "Approved" while the
 * mascot, the event count and the verdict line beside it still described the run before the
 * decision.
 */
export function StatusCard({
  status,
  issueUrl,
  channel,
  repositoryFullName,
}: {
  status: CaseLiveView;
  issueUrl: string | null;
  /** Header facts that identify the report rather than track it, so they come from the page. */
  channel: string;
  repositoryFullName: string | null;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/50 bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <h2 className="text-heading text-foreground">Current run</h2>
          {/* The status text does not distinguish "queued" from "an agent is actively
              working this right now" -- this badge is that difference. */}
          {status.investigating ? <Badge variant="secondary">Agent investigating</Badge> : null}
        </div>
        {issueUrl ? (
          <Button
            size="sm"
            variant="outline"
            nativeButton={false}
            render={<a href={issueUrl} target="_blank" rel="noreferrer" />}
          >
            <RollingIcon icon={GitHubLight} className="size-4" /> Open on GitHub
          </Button>
        ) : null}
      </header>

      <div className="flex flex-col gap-6 p-5 sm:flex-row sm:items-center">
        <AnimatedMascotSvg
          state={status.mascotKey}
          scope="status"
          className="size-32 shrink-0 self-center"
        />

        <div className="grid min-w-0 flex-1 gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Status">{status.stateLabel}</Fact>
          <Fact label="Bound target">{status.target?.name ?? "None bound"}</Fact>
          <Fact label="Intake">{repositoryFullName ?? channel}</Fact>
          <Fact label={status.verdict?.verdictLabel ?? "Agent Bounty says"}>
            {status.verdict
              ? `${status.verdict.outcomeLabel} · revision ${status.verdict.revision}`
              : "Nothing drafted yet"}
          </Fact>
          <Fact label="Recorded events">
            {status.eventCount === 0
              ? "None yet"
              : `${status.eventCount} ${status.eventCount === 1 ? "event" : "events"}`}
          </Fact>
          <Fact label="Last change">
            <time dateTime={status.updatedAt}>{formatStamp(new Date(status.updatedAt))}</time>
          </Fact>
        </div>
      </div>
    </section>
  );
}

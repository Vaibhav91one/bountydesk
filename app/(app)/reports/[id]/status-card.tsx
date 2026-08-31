import { GitHubLight } from "developer-icons";

import { RollingIcon } from "@/components/rolling-icon";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatStamp } from "@/lib/format";
import { mascotForState } from "@/lib/mascot/states";
import { isAgentInvestigating, type CaseFile } from "@/lib/reports/case";
import type { CaseStatusView } from "@/lib/reports/status-view";

import { CaseRealtimeStatus } from "./case-realtime-status";

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
 */
export function StatusCard({
  file,
  verdictLabel,
  outcomeLabel,
  initialStatus,
}: {
  file: CaseFile;
  verdictLabel: string;
  outcomeLabel: string | null;
  initialStatus: CaseStatusView;
}) {
  const mascot = mascotForState(file.state);
  const hasToolCallEvents = file.events.some((e) => e.channel === "agent");
  const investigating = isAgentInvestigating(file.turnStatus, file.verdict !== null, hasToolCallEvents);

  return (
    <section className="overflow-hidden rounded-xl border border-border/50 bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <h2 className="text-heading text-foreground">Current run</h2>
          {/* The status text does not distinguish "queued" from "an agent is actively
              working this right now" -- this badge is that difference. */}
          {investigating ? <Badge variant="secondary">Agent investigating</Badge> : null}
        </div>
        {file.issueUrl ? (
          <Button
            size="sm"
            variant="outline"
            nativeButton={false}
            render={<a href={file.issueUrl} target="_blank" rel="noreferrer" />}
          >
            <RollingIcon icon={GitHubLight} className="size-4" /> Open on GitHub
          </Button>
        ) : null}
      </header>

      <div className="flex flex-col gap-6 p-5 sm:flex-row sm:items-center">
        {/* The id prefix is per state, so two mascots for two different states could never
            share ids even if both were on one page. */}
        <span
          aria-hidden="true"
          className="size-32 shrink-0 self-center [&>svg]:block [&>svg]:size-full"
          dangerouslySetInnerHTML={{
            __html: mascot.markup.replaceAll(`${mascot.key}__`, `${mascot.key}__status__`),
          }}
        />

        <div className="grid min-w-0 flex-1 gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Status">
            <CaseRealtimeStatus reportId={file.id} initialStatus={initialStatus} />
          </Fact>
          <Fact label="Bound target">{file.target?.name ?? "None bound"}</Fact>
          <Fact label="Intake">{file.repositoryFullName ?? file.channel}</Fact>
          <Fact label={verdictLabel}>
            {file.verdict && outcomeLabel
              ? `${outcomeLabel} · revision ${file.verdict.revision}`
              : "Nothing drafted yet"}
          </Fact>
          <Fact label="Recorded events">
            {file.events.length === 0
              ? "None yet"
              : `${file.events.length} ${file.events.length === 1 ? "event" : "events"}`}
          </Fact>
          <Fact label="Last change">
            <time dateTime={file.updatedAt.toISOString()}>
              {formatStamp(file.updatedAt)}
            </time>
          </Fact>
        </div>
      </div>
    </section>
  );
}

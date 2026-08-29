import { ArrowSquareOut } from "@phosphor-icons/react/ssr";

import { Button } from "@/components/ui/button";
import { mascotForState } from "@/lib/mascot/states";
import type { CaseFile } from "@/lib/reports/case";

/** One fact. The value is always something the database holds. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-label text-muted-foreground uppercase">{label}</span>
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
  stateLabel,
  verdictLabel,
  outcomeLabel,
}: {
  file: CaseFile;
  stateLabel: string;
  verdictLabel: string;
  outcomeLabel: string | null;
}) {
  const mascot = mascotForState(file.state);

  return (
    <section className="overflow-hidden rounded-xl border border-border/50 bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-5 py-4">
        <h2 className="text-heading text-foreground">Current run</h2>
        {file.issueUrl ? (
          <Button
            size="sm"
            variant="outline"
            nativeButton={false}
            render={<a href={file.issueUrl} target="_blank" rel="noreferrer" />}
          >
            Open on GitHub <ArrowSquareOut className="size-3.5" />
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
          <Fact label="Status">{stateLabel}</Fact>
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
              {file.updatedAt.toISOString().replace("T", " ").slice(0, 16)} UTC
            </time>
          </Fact>
        </div>
      </div>
    </section>
  );
}

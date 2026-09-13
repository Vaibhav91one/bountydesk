import { ClipboardText } from "@phosphor-icons/react/ssr";

import { formatStamp } from "@/lib/format";

/**
 * The agent's own closing message from the run it just finished, as a record with attribution
 * rather than a bare paragraph.
 *
 * The text is what Agent Bounty wrote when its turn ended, captured by the poller from the
 * harness's final summary. It is data, not a document: the agent may have read
 * prompt-injection content while probing an untrusted target, so it is rendered as text with
 * whitespace preserved and never interpreted as HTML or markdown. The card frames it as the
 * agent's words next to a stamp of when the run said them, so a reviewer skimming a case that
 * has been through several runs knows this is the latest run's closing note, not the verdict
 * and not the findings table.
 */
export function SummaryCard({
  summary,
  updatedAt,
}: {
  summary: string;
  /** When the page's data was last read; the summary row carries its own updated_at. */
  updatedAt: string;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border/50 bg-card p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-meta text-muted-foreground">
          <ClipboardText aria-hidden="true" className="size-4" />
          Summary and next steps
        </span>
        <span className="font-mono text-meta text-muted-foreground">
          {formatStamp(new Date(updatedAt))}
        </span>
      </header>

      <p className="whitespace-pre-wrap break-words text-body text-foreground">{summary}</p>

      <span className="text-meta text-muted-foreground">
        {"Agent Bounty's closing message for the latest run. The findings table above carries the "}
        {"structured findings; this is the agent's own account of what it did and what to look at "}
        {"next."}
      </span>
    </section>
  );
}

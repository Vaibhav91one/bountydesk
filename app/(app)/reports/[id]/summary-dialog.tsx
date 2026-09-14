"use client";

import { ClipboardText } from "@phosphor-icons/react/ssr";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { formatStamp } from "@/lib/format";

/**
 * The agent's own closing message from the run it just finished, behind a button.
 *
 * The text is what Agent Bounty wrote when its turn ended, captured by the poller from the
 * harness's final summary. It is data, not a document: the agent may have read
 * prompt-injection content while probing an untrusted target, so it is rendered as text with
 * whitespace preserved and never interpreted as HTML or markdown. The message ran long enough
 * to dominate the case page when it was inline, so it opens in a dialog beside the verdict's
 * own button, and the page keeps its summary: the label, not the text.
 */
export function SummaryDialog({
  summary,
  updatedAt,
}: {
  summary: string;
  /** When the page's data was last read; the summary row carries its own updated_at. */
  updatedAt: string;
}) {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline">
            <ClipboardText aria-hidden="true" className="size-4" />
            Agent summary
          </Button>
        }
      />
      <DialogContent className="no-scrollbar flex max-h-[85vh] flex-col gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Agent summary</DialogTitle>
          <DialogDescription>
            {"Agent Bounty's closing message for the latest run, "}
            {formatStamp(new Date(updatedAt))}
            {
              ". The findings table carries the structured findings; this is the agent's own account of what it did and what to look at next."
            }
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-6">
          <div className="rounded-md border border-border/50 bg-muted/30 px-4 py-3">
            <p className="whitespace-pre-wrap break-words text-body text-foreground">{summary}</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

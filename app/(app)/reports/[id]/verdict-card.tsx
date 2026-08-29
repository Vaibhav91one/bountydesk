"use client";

import { useState } from "react";
import { CaretDown } from "@phosphor-icons/react/ssr";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * How much evidence stands behind a verdict, and what to call it.
 *
 * Three bars is the oracle having decided. Everything else is fewer, and analysis only is one,
 * because no sandbox ran and nobody observed anything. The meter is a reading of the record,
 * not a confidence the model reported: there is no such number, and inventing one to fill a
 * meter would be the model grading its own work.
 */
const EVIDENCE: Record<string, { bars: number; tone: string; label: string }> = {
  REPRODUCED: { bars: 3, tone: "bg-phase-delivered", label: "Oracle observed the canary" },
  NOT_REPRODUCED: { bars: 2, tone: "bg-phase-analysis", label: "Ran, did not reproduce" },
  INCONCLUSIVE: { bars: 1, tone: "bg-phase-approval", label: "Inconclusive" },
  ANALYSIS_ONLY: { bars: 1, tone: "bg-phase-approval", label: "Analysis only, nothing ran" },
};

function Meter({ bars, tone }: { bars: number; tone: string }) {
  return (
    <span aria-hidden="true" className="flex items-end gap-0.5">
      {[0, 1, 2].map((bar) => (
        <span
          key={bar}
          className={cn("h-2.5 w-1 rounded-full", bar < bars ? tone : "bg-border")}
        />
      ))}
    </span>
  );
}

/**
 * The comment, and the decision about it.
 *
 * Ported from a recommendation card: a question as the heading, the thing being decided as the
 * body, a drawer for the detail, and a footer that reads the strength on the left and acts on
 * the right. The drawer holds what approving actually binds, because that is the detail a
 * reviewer would open it for.
 */
export function VerdictCard({
  payload,
  outcome,
  outcomeLabel,
  revision,
  contentHash,
  destination,
  onChat,
  approve,
  approving,
  disabled,
}: {
  payload: string;
  outcome: string;
  outcomeLabel: string;
  revision: number;
  contentHash: string;
  destination: string;
  onChat: () => void;
  approve: () => void;
  approving: boolean;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const evidence = EVIDENCE[outcome] ?? EVIDENCE.INCONCLUSIVE;

  return (
    <div className="overflow-hidden rounded-xl border border-border/50 bg-card">
      <div className="flex flex-col gap-3 p-4">
        <span className="text-body font-medium text-foreground">
          Post this comment to the issue?
        </span>

        {/* The exact bytes, plain. A rendering of them is not them. */}
        <pre className="max-h-56 overflow-auto rounded-md border border-border/50 bg-background p-4 text-body whitespace-pre-wrap text-foreground">
          {payload}
        </pre>
      </div>

      <div className="border-t border-border/50">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-muted/40"
        >
          <span className="flex-1 text-meta text-muted-foreground">What approving binds</span>
          <CaretDown
            aria-hidden="true"
            className={cn(
              "size-3.5 text-muted-foreground transition-transform duration-300",
              open && "rotate-180",
            )}
          />
        </button>

        <div
          className="grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]"
          style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
        >
          <div className="overflow-hidden">
            <dl className="flex flex-col gap-2 px-4 pb-3">
              <div className="flex justify-between gap-4">
                <dt className="text-meta text-muted-foreground">Outcome</dt>
                <dd className="text-meta text-foreground">
                  {outcomeLabel} · revision {revision}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="shrink-0 text-meta text-muted-foreground">Content hash</dt>
                <dd className="min-w-0 font-mono text-meta break-all text-foreground">
                  {contentHash}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="shrink-0 text-meta text-muted-foreground">Destination</dt>
                <dd className="min-w-0 truncate text-meta text-foreground">{destination}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 bg-card px-4 py-3">
        <span className="flex items-center gap-2">
          <Meter bars={evidence.bars} tone={evidence.tone} />
          <span className="text-meta text-muted-foreground">{evidence.label}</span>
        </span>

        <span className="flex items-center gap-2">
          {/* Not approving is a conversation, not a second button that fires immediately. */}
          <Button size="sm" variant="outline" onClick={onChat} disabled={disabled}>
            Chat with agent
          </Button>
          <Button size="sm" onClick={approve} loading={approving} disabled={disabled}>
            Approve
          </Button>
        </span>
      </div>
    </div>
  );
}

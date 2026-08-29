"use client";

import Image from "next/image";
import { useState } from "react";
import { CaretDown, CheckCircle, Prohibit } from "@phosphor-icons/react/ssr";

import { RollingIcon } from "@/components/rolling-icon";
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

/**
 * The comment split into paragraphs, minus the delivery marker.
 *
 * The marker is an HTML comment the delivery worker uses to recognise its own past comment, so
 * GitHub never shows it and neither does this. Everything else is passed through untouched: a
 * markdown feature this does not know about renders as its own source, which is wrong-looking
 * but honest, and better than quietly dropping a line.
 */
function paragraphs(payload: string): string[] {
  return payload
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim()
    .split(/\n{2,}/)
    // The stored payload is hard-wrapped at roughly 95 columns, which is right for a raw
    // markdown file and wrong for a column of this width: it breaks mid-sentence wherever the
    // author's editor happened to. Markdown joins those lines anyway, so this does too, and
    // each block becomes the one paragraph GitHub will render.
    .map((block) => block.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
}

/** The sign-off the delivery worker appends to every payload. */
const SIGNATURE = /^Signed via BountyDesk\.?$/;

/** **bold** and nothing else. The payloads this product writes use no other markup. */
function emphasise(block: string): React.ReactNode[] {
  return block.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={index} className="font-medium">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  );
}

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
  speaker,
  chatMascot,
  onChat,
  approve,
  approving,
  deny,
  denying,
  disabled,
  decision,
}: {
  payload: string;
  outcome: string;
  outcomeLabel: string;
  revision: number;
  contentHash: string;
  destination: string;
  /** Agent Bounty, inline SVG. The comment is what it drafted, so it says so. */
  speaker: string;
  chatMascot: string;
  onChat?: () => void;
  approve?: () => void;
  approving?: boolean;
  deny?: () => void;
  denying?: boolean;
  disabled?: boolean;
  /**
   * Who signed, once somebody has. Only read when the card is read-only, which is when no
   * approve handler is passed: null then means a verdict exists that nobody has answered.
   */
  decision?: { decision: string; reviewer: string; note: string | null; at: string } | null;
}) {
  const [open, setOpen] = useState(false);
  const evidence = EVIDENCE[outcome] ?? EVIDENCE.INCONCLUSIVE;

  return (
    <div className="overflow-hidden rounded-xl border border-border/50 bg-card">
      <div className="flex flex-col gap-3 p-4">
        <span className="text-body font-medium text-foreground">
          {approve ? "Post this comment to the issue?" : "The comment on record"}
        </span>

        {/* Attributed, because a reviewer approving a comment should be able to see at a
            glance whose words they are. Agent Bounty drafted it; the reviewer signs it. */}
        <div className="flex gap-3">
          <span
            aria-hidden="true"
            className="size-11 shrink-0 [&>svg]:block [&>svg]:size-full"
            dangerouslySetInnerHTML={{ __html: speaker }}
          />

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="flex items-center gap-1.5">
              <span className="text-meta text-foreground">Agent Bounty</span>
              <span className="text-meta text-muted-foreground">drafted this reply</span>
            </span>

        {/* Shown the way the issue will show it, because that is what the reporter reads.
            The bytes underneath are unchanged and the hash in the drawer is what approving
            binds, so a preview that renders differently cannot change what gets posted. */}
        <div className="flex flex-col gap-3 text-body text-foreground">
          {paragraphs(payload).map((block, index) =>
            SIGNATURE.test(block) ? (
              // The comment signs itself off, so the mark goes on the signature rather than
              // beside the name. It is the same line the issue will carry, drawn.
              <span key={index} className="flex items-center gap-2 text-muted-foreground">
                <Image src="/logo-small.svg" alt="" width={16} height={16} />
                {block}
              </span>
            ) : (
              <p key={index}>{emphasise(block)}</p>
            ),
          )}
            </div>
          </div>
        </div>
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

      {/* Pinned: the comment can be long enough to scroll the decision off the screen, and a
          reviewer should never have to hunt for the button they came here to press. */}
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-border/50 bg-card px-4 py-3">
        <span className="flex items-center gap-2">
          <Meter bars={evidence.bars} tone={evidence.tone} />
          <span className="text-meta text-muted-foreground">{evidence.label}</span>
        </span>

        {/* No approve handler is what makes this card a record rather than a decision. */}
        {!approve ? (
          decision ? (
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span
                className={cn(
                  "text-body",
                  decision.decision === "APPROVED"
                    ? "text-phase-delivered"
                    : "text-destructive",
                )}
              >
                {decision.decision === "APPROVED" ? "Approved" : "Denied"}
              </span>
              <span className="text-meta text-muted-foreground">
                by {decision.reviewer} on {decision.at}
                {decision.note ? ` · ${decision.note}` : ""}
              </span>
            </span>
          ) : (
            <span className="text-meta text-muted-foreground">
              Not decided. Approval only opens while the harness is holding a pending
              publish_verdict call.
            </span>
          )
        ) : (
        <span className="flex items-center gap-2">
          {/* Not approving is meant to be a conversation, and the conversation is not built.
              Parked rather than removed: the panel behind it works, but nothing a reviewer
              typed would reach the harness, so offering it would promise a channel that does
              not exist. It sits apart from the pair that decide. */}
          <Button size="sm" variant="outline" onClick={onChat} disabled title="Coming soon">
            {/* Agent Bounty rather than a speech-bubble glyph: the button names it, so it
                should look like it. */}
            <span
              aria-hidden="true"
              className="-my-1 size-6 shrink-0 [&>svg]:block [&>svg]:size-full"
              dangerouslySetInnerHTML={{ __html: chatMascot }}
            />
            Chat with Agent Bounty
            <span className="text-meta text-muted-foreground">Coming soon</span>
          </Button>

          {/* Both outcomes stay reachable, and next to each other. The conversation was going
              to be how a reviewer said no; with it parked, denying needs a button of its own,
              because a gate that only opens one way is not a gate. */}
          <Button
            size="sm"
            variant="ghost"
            onClick={deny}
            loading={denying}
            disabled={disabled}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <RollingIcon icon={Prohibit} className="size-4" /> Deny
          </Button>
          <Button size="sm" onClick={approve} loading={approving} disabled={disabled}>
            <RollingIcon icon={CheckCircle} className="size-4" /> Approve
          </Button>
        </span>
        )}
      </div>
    </div>
  );
}

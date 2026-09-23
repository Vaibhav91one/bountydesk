"use client";

import { useState } from "react";
import { ArrowClockwise, CaretDown, ChatCircleDots, CheckCircle, Prohibit } from "@phosphor-icons/react/ssr";

import { AnimatedMascotSvg } from "@/components/animated-mascot-svg";
import { RollingIcon } from "@/components/rolling-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MascotKey } from "@/lib/mascot/catalog";
import type { Finding } from "@/lib/mcp/publish-verdict";
import { draftPrompt, draftRecordLabel } from "@/lib/reports/channel-copy";
import { canOfferRecheck } from "@/lib/reports/recheck-actions-view";
import { cn } from "@/lib/utils";

import { VerdictBody, VerdictDialog } from "./verdict-dialog";

/**
 * How much evidence stands behind a verdict, and what to call it.
 *
 * Three bars is the agent's own investigation reaching a positive result; two is a run that
 * completed and found nothing; one is no investigation having happened at all. The meter is a
 * reading of the record, not a confidence the model reported: there is no such number, and
 * inventing one to fill a meter would be the model grading its own work.
 */
const EVIDENCE: Record<string, { bars: number; tone: string; label: string }> = {
  REPRODUCED: { bars: 3, tone: "bg-phase-delivered", label: "Agent's own investigation" },
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
  payloadArtifactId,
  findingsArtifactId,
  outcome,
  outcomeLabel,
  summary,
  findings,
  revision,
  contentHash,
  destination,
  channel,
  speaker,
  speakerScope = "speaker",
  onChat,
  approve,
  deny,
  disabled,
  onRecheck,
  rechecking,
  decision,
  superseded,
}: {
  /** The exact outbound comment body. Kept for the download's Blob fallback, not rendered raw. */
  payload: string;
  /** The stored verdict-payload artifact, when one exists. */
  payloadArtifactId: string | null;
  /** The stored findings file, when one exists. Offered in place of a sandbox path. */
  findingsArtifactId?: string | null;
  outcome: string;
  outcomeLabel: string;
  /** The agent's own summary and findings, rendered as text (never as HTML) by VerdictBody. */
  summary: string;
  findings: Finding[];
  revision: number;
  contentHash: string;
  destination: string;
  /** Decides whether this reads as a comment on an issue or a reply to the reporter. */
  channel: string;
  /** Agent Bounty. The comment is what it drafted, so it says so. */
  speaker: MascotKey;
  speakerScope?: string;
  onChat?: () => void;
  approve?: () => void;
  deny?: () => void;
  disabled?: boolean;
  /** Starts a fresh guided investigation that supersedes this verdict. Lives beside Approve. */
  onRecheck?: () => void;
  rechecking?: boolean;
  /**
   * Who signed, once somebody has. Only read when the card is read-only, which is when no
   * approve handler is passed: null then means a verdict exists that nobody has answered.
   */
  decision?: { decision: string; reviewer: string; note: string | null; at: string } | null;
  /** True when a later run superseded this verdict. The card keeps rendering it as history. */
  superseded?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const evidence = EVIDENCE[outcome] ?? EVIDENCE.INCONCLUSIVE;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border/50 bg-card",
        approve && "flex min-h-0 flex-1 flex-col",
      )}
    >
      <div className={cn("flex flex-col gap-3 p-4", approve && "shrink-0 pb-3")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-body font-medium text-foreground">
              {approve ? draftPrompt(channel) : draftRecordLabel(channel)}
            </span>
            {superseded ? (
              <Badge variant="outline">Superseded by a re-check</Badge>
            ) : null}
          </span>
          {/* The comment itself opens from the button row on the case page. Here, the record
              keeps what approving bound: the heading names it, the drawer under it carries the
              hashes, and the footer the decision. Approve mode still renders the full body
              inline below, because that dialog is where the exact text is approved. */}
          {!approve ? (
            <VerdictDialog
              channel={channel}
              outcomeLabel={outcomeLabel}
              revision={revision}
              summary={summary}
              findings={findings}
              payload={payload}
              payloadArtifactId={payloadArtifactId}
              findingsArtifactId={findingsArtifactId}
            />
          ) : null}
        </div>
      </div>

      {approve ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Attributed, because a reviewer approving a comment should be able to see at a
              glance whose words they are. Agent Bounty drafted it; the reviewer signs it. This
              region fills the dialog and scrolls on its own, so the action row below never moves
              off screen while a long comment does. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
            <div className="flex gap-3">
              <AnimatedMascotSvg
                state={speaker}
                scope={speakerScope}
                className="size-11 shrink-0 [&>svg]:block [&>svg]:size-full"
              />

              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <span className="flex items-center gap-1.5">
                  <span className="text-meta text-foreground">Agent Bounty</span>
                  <span className="text-meta text-muted-foreground">drafted this reply</span>
                </span>

                {/* Rendered from structured fields, never by parsing the markdown payload. The
                    scroll container above holds the full body, so there is no preview toggle. */}
                <VerdictBody
                  summary={summary}
                  findings={findings}
                  findingsArtifactId={findingsArtifactId}
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className={cn("border-t border-border/50", approve && "shrink-0")}>
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

      {/* The reading sits left and the decision right, and they hold those sides. An earlier
          flex-wrap here let the button group wrap under the meter the moment a label grew (a
          button entering its loading state is enough), which moved the buttons mid-click. The
          row keeps its axis and the meter gives up width instead: it truncates, the buttons do
          not move. Below sm the two stack deliberately, in that order.

          In approve mode this is the last child of a full-height column (the card fills the
          dialog pane), so it sits flush at the bottom without needing to stick to anything. */}
      <div
        className={cn(
          "flex flex-col gap-3 border-t border-border/50 bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between",
          approve && "shrink-0",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Meter bars={evidence.bars} tone={evidence.tone} />
          <span className="truncate text-meta text-muted-foreground">{evidence.label}</span>
        </span>

        {/* No approve handler is what makes this card a record rather than a decision. */}
        {!approve ? (
          decision ? (
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 sm:justify-end">
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
            <span className="text-meta text-muted-foreground sm:text-right">
              Not decided. Approval only opens while the harness is holding a pending
              publish_verdict call.
            </span>
          )
        ) : (
        <span className="flex shrink-0 items-center justify-end gap-2">
          {/* Chat is advisory and has no path to either decision. Approval and denial remain
              separate guarded controls beside it. */}
          <Button size="sm" variant="outline" onClick={onChat} disabled={disabled}>
            <RollingIcon icon={ChatCircleDots} className="size-4" />
            Chat with Agent Bounty
          </Button>

          {/* Both outcomes stay reachable, and next to each other. The conversation was going
              to be how a reviewer said no; with it parked, denying needs a button of its own,
              because a gate that only opens one way is not a gate. */}
          <Button
            size="sm"
            variant="ghost"
            onClick={deny}
            disabled={disabled}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <RollingIcon icon={Prohibit} className="size-4" /> Deny
          </Button>
          {/* A re-check is only worth offering when it can change the outcome, which a reproduced
              verdict never should (a weaker follow-up run, say an HTTP-only probe that misses a
              client-side sink, could supersede it with NOT_REPRODUCED). With no re-check to offer,
              the "Decide" menu would hold a single item, so approving is a plain button instead. */}
          {onRecheck && canOfferRecheck(outcome) ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    size="sm"
                    variant="default"
                    disabled={disabled}
                    aria-label="Choose a decision"
                    aria-haspopup="menu"
                  >
                    Decide
                    <CaretDown className="size-3" aria-hidden="true" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" side="top">
                <DropdownMenuItem onClick={approve}>
                  <RollingIcon icon={CheckCircle} className="size-4" />
                  Approve
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => onRecheck()}
                  disabled={disabled || rechecking}
                >
                  <RollingIcon icon={ArrowClockwise} className="size-4" />
                  {rechecking ? "Starting re-check…" : "Ask to re-check"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button size="sm" variant="default" onClick={approve} disabled={disabled}>
              <RollingIcon icon={CheckCircle} className="size-4" /> Approve
            </Button>
          )}
        </span>
        )}
      </div>
    </div>
  );
}

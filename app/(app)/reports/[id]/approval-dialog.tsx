"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle, Signature, Warning } from "@phosphor-icons/react/ssr";

import { AnimatedMascotSvg } from "@/components/animated-mascot-svg";
import { RollingIcon } from "@/components/rolling-icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import { allowVerdict, denyVerdict, requestRecheckAction, type ActionResult } from "@/app/review/actions";
import type { MascotKey } from "@/lib/mascot/catalog";
import type { Finding } from "@/lib/mcp/publish-verdict";
import { applyDecisionOptimistically, refreshReportViews } from "@/lib/reports/live-keys";

import { AgentChat } from "./agent-chat";
import { VerdictCard } from "./verdict-card";

/**
 * Everything a reviewer needs before signing, in one place.
 *
 * Two ways out, and they are not symmetric. Approving is one click on the card, because the
 * comment is right there to read. Not approving goes through the conversation: you say what is
 * wrong, and that sentence becomes the reason on the denial. It is the one reviewer-to-system
 * message this product records, so the chat writes to something real rather than being a
 * decoration next to the buttons.
 *
 * The gate itself has not moved. Both actions are the same guarded server actions the page
 * calls, and those re-read and lock their own rows and refuse a payload whose hash has changed.
 * Nothing in this dialog decides anything on its own.
 */
export function ApprovalDialog({
  reportId,
  verdictId,
  contentHash,
  payload,
  payloadArtifactId,
  findingsArtifactId,
  outcome,
  outcomeLabel,
  summary,
  revision,
  destination,
  findings,
  speaker,
  speakerScope,
}: {
  reportId: string;
  verdictId: string;
  contentHash: string;
  payload: string;
  /** The stored verdict-payload artifact, when one exists. Threaded to the card's download. */
  payloadArtifactId: string | null;
  /** The stored findings file, when one exists. Offered in place of a sandbox path. */
  findingsArtifactId: string | null;
  outcome: string;
  outcomeLabel: string;
  summary: string;
  revision: number;
  destination: string;
  /** What the agent's own investigation found, beyond the summary. May be empty. */
  findings: Finding[];
  speaker: MascotKey;
  speakerScope: string;
}) {
  const queryClient = useQueryClient();
  const [chatting, setChatting] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [acting, setActing] = useState<"allow" | "deny" | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [decision, setDecision] = useState<"ALLOWED" | "DENIED" | null>(null);
  const [recheckState, setRecheckState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [recheckError, setRecheckError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Which irreversible decision the reviewer just clicked, if any. null means no
  // confirmation dialog is showing.
  const [confirming, setConfirming] = useState<"allow" | "deny" | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setChatting(false);
    if (next) {
      setResult(null);
      setDecision(null);
    }
  }

  async function requestRecheck() {
    if (recheckState === "sending" || recheckState === "sent") return;
    if (!window.confirm("Start a fresh investigation? This supersedes the current verdict and requires a new approval.")) return;
    // The guidance is a neutral default: the dialog cannot see the chat draft, and the
    // server re-validates everything. This string is a suggestion, never authority over
    // target, tools, or approval.
    setRecheckState("sending");
    setRecheckError(null);
    try {
      const answer = await requestRecheckAction(
        reportId,
        verdictId,
        "The reviewer asked for a fresh look at this report. Investigate it from scratch and draft your own conclusion.",
      );
      if (!answer.ok) throw new Error(answer.error ?? "The re-check could not be started.");
      setRecheckState("sent");
    } catch (error) {
      setRecheckState("error");
      setRecheckError(error instanceof Error ? error.message : "The re-check could not be started.");
    }
  }

  function requestDecision(kind: "allow" | "deny") {
    // The reviewer clicked Approve or Deny. Rather than committing immediately,
    // surface a confirmation dialog so the irreversible action is deliberate.
    setConfirming(kind);
  }

  async function confirmDecision() {
    if (!confirming) return;
    if (acting) return;
    const kind = confirming;
    setConfirming(null);
    setActing(kind);
    try {
      const answer =
        kind === "allow"
          ? await allowVerdict(reportId, verdictId)
          : await denyVerdict(reportId, verdictId, reason ?? undefined);
      setActing(null);
      setResult(answer);
      if (!answer.ok) return;

      setDecision(kind === "allow" ? "ALLOWED" : "DENIED");
      setOpen(false);

      // The action has already committed by the time it returns, so writing the decision into the
      // cache is not optimism, it is the same fact a round trip earlier. It is what takes this
      // button off the screen and puts the signed record in its place on the next render; the
      // refetch behind it fills in everything the server derives from the decision.
      applyDecisionOptimistically(queryClient, reportId, kind === "allow" ? "APPROVED" : "DENIED");
      await refreshReportViews(queryClient, reportId);
    } catch (error) {
      setActing(null);
      setResult({
        ok: false,
        error: error instanceof Error ? error.message : "The decision could not be completed.",
      });
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button
            size="sm"
            disabled={decision !== null}
            className="relative animate-approval-halo bg-phase-approval text-background hover:bg-phase-approval/85 motion-reduce:animate-none"
          >
            <RollingIcon icon={Signature} weight="fill" className="size-4" />{" "}
            {decision ? "Updating verdict" : "Approval needed"}
          </Button>
        }
      />

      <DialogContent className="flex h-[85vh] max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div
            className={`absolute inset-0 flex min-h-0 w-[200%] transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${
              chatting ? "-translate-x-1/2" : "translate-x-0"
            }`}
          >
            <section className="flex min-h-0 min-w-0 w-1/2 shrink-0 flex-col overflow-hidden" aria-hidden={chatting} inert={chatting || undefined}>
              <DialogHeader className="shrink-0 border-b border-border/50 p-5 pr-14">
                <DialogTitle>Sign the verdict</DialogTitle>
                <DialogDescription>
                  The run has stopped here. Approve the exact words below, or say what is wrong with
                  them.
                </DialogDescription>
              </DialogHeader>

              <div className="flex min-h-0 flex-1 flex-col gap-5 p-5">
                {decision ? (
                  <p
                    role="status"
                    className="flex shrink-0 items-start gap-2.5 rounded-md bg-emerald-500/10 px-4 py-3 text-body text-emerald-400"
                  >
                    <CheckCircle className="mt-0.5 size-4 shrink-0" />
                    {decision === "ALLOWED"
                      ? "Approved. BountyDesk is moving the exact signed verdict through delivery."
                      : "Denied. Nothing will be posted, and the report is closed on BountyDesk's side."}
                  </p>
                ) : (
                  <>
                    {result && !result.ok ? (
                      <p
                        role="alert"
                        className="flex shrink-0 items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-body text-destructive"
                      >
                        <Warning className="mt-0.5 size-4 shrink-0" />
                        <span>
                          {result.error}. Nothing was recorded; reload to see the state the database is
                          actually in.
                        </span>
                      </p>
                    ) : null}

                    <VerdictCard
                      payload={payload}
                      payloadArtifactId={payloadArtifactId}
                      findingsArtifactId={findingsArtifactId}
                      outcome={outcome}
                      outcomeLabel={outcomeLabel}
                      summary={summary}
                      findings={findings}
                      revision={revision}
                      contentHash={contentHash}
                      destination={destination}
                      speaker={speaker}
                      speakerScope={speakerScope}
                      onChat={() => setChatting(true)}
                      approve={() => requestDecision("allow")}
                      deny={() => requestDecision("deny")}
                      disabled={acting !== null}
                      onRecheck={() => void requestRecheck()}
                      rechecking={recheckState === "sending" || recheckState === "sent"}
                    />
                  </>
                )}
              </div>
            </section>

            <section className="flex min-h-0 min-w-0 w-1/2 shrink-0 flex-col overflow-hidden" aria-hidden={!chatting} inert={!chatting || undefined}>
              <div className="sticky top-0 z-10 grid grid-cols-[1fr_auto_1fr] items-center border-b border-border/50 bg-popover p-4">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  // Focus stays on this button after the click, and the slide marks
                  // this pane aria-hidden: a focused descendant under aria-hidden
                  // is blocked by the browser, so release focus first.
                  onClick={(event) => {
                    event.currentTarget.blur();
                    setChatting(false);
                  }}
                  className="relative z-10 justify-self-start"
                >
                  <RollingIcon icon={ArrowLeft} className="size-4" /> Back
                </Button>
                <div className="flex items-center gap-2 text-body font-medium text-foreground">
                  <AnimatedMascotSvg
                    state="greeting"
                    scope="approval-chat-header"
                    className="size-9 [&>svg]:block [&>svg]:size-full"
                  />
                  <h2>Agent Bounty</h2>
                </div>
              </div>
              <div className="flex min-h-0 flex-1 flex-col">
                <AgentChat
                  key={`${reportId}:${verdictId}`}
                  reportId={reportId}
                  active={chatting}
                  onReasonChange={setReason}
                  recheckState={recheckState}
                  recheckError={recheckError}
                />
              </div>
            </section>
          </div>
        </div>
      </DialogContent>
    </Dialog>

    {/* Confirmation dialog for the irreversible Approve / Deny actions. Shows when
        requestDecision sets `confirming`; confirmDecision commits it. */}
    <Dialog open={confirming !== null} onOpenChange={(next) => !next && setConfirming(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {confirming === "allow" ? "Approve this verdict?" : "Deny this verdict?"}
          </DialogTitle>
          <DialogDescription>
            {confirming === "allow"
              ? "This posts the drafted comment to the issue as the agent's verdict. This action cannot be undone."
              : "This closes the case on BountyDesk. The chat reason (if any) is not sent to the reporter. This action cannot be undone."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => setConfirming(null)}
            disabled={acting !== null}
          >
            Cancel
          </Button>
          <Button
            variant={confirming === "allow" ? "default" : "destructive"}
            onClick={() => void confirmDecision()}
            loading={acting !== null}
            disabled={acting !== null}
          >
            {confirming === "allow" ? "Approve" : "Deny"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}

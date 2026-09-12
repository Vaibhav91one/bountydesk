"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle, Signature, Warning } from "@phosphor-icons/react/ssr";

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

import { allowVerdict, denyVerdict, type ActionResult } from "@/app/review/actions";
import type { MascotKey } from "@/lib/mascot/catalog";
import type { Finding } from "@/lib/mcp/publish-verdict";
import type { LifecycleEventView } from "@/lib/reports/case-view";
import { applyDecisionOptimistically, refreshReportViews } from "@/lib/reports/live-keys";
import type { ToolCallView } from "@/lib/reports/tool-call-view";

import { AgentChat } from "./agent-chat";
import { AgentTrace } from "./agent-trace";
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
  chatMascot,
  chatMascotScope,
  events,
  details,
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
  chatMascot: MascotKey;
  chatMascotScope: string;
  events: LifecycleEventView[];
  details?: Record<string, ToolCallView>;
}) {
  const queryClient = useQueryClient();
  const [chatting, setChatting] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [acting, setActing] = useState<"allow" | "deny" | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [decision, setDecision] = useState<"ALLOWED" | "DENIED" | null>(null);
  const [open, setOpen] = useState(false);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setResult(null);
      setDecision(null);
    }
  }

  async function decide(kind: "allow" | "deny") {
    if (acting) return;
    setActing(kind);
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
  }

  return (
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

      <DialogContent className="no-scrollbar max-h-[85vh] gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border/50 p-5">
          <DialogTitle>Sign the verdict</DialogTitle>
          <DialogDescription>
            The run has stopped here. Approve the exact words below, or say what is wrong with
            them.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 p-5">
          <AgentTrace rows={events} details={details} />

          {decision ? (
            <p
              role="status"
              className="flex items-start gap-2.5 rounded-md bg-emerald-500/10 px-4 py-3 text-body text-emerald-400"
            >
              <CheckCircle className="mt-0.5 size-4 shrink-0" />
              {decision === "ALLOWED"
                ? "Approved. BountyDesk is moving the exact signed verdict through delivery."
                : "Denied. Nothing will be posted, and the report is closed on BountyDesk's side."}
            </p>
          ) : (
            <>
              {/* Every refusal string comes from the action, which is the thing that actually
                  re-reads and locks the rows. Restating it here would be a second opinion. */}
              {result && !result.ok ? (
                <p
                  role="alert"
                  className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-body text-destructive"
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
                chatMascot={chatMascot}
                chatMascotScope={chatMascotScope}
                onChat={() => setChatting(true)}
                approve={() => decide("allow")}
                approving={acting === "allow"}
                deny={() => decide("deny")}
                denying={acting === "deny"}
                disabled={acting !== null}
              />

              {chatting ? (
                <AgentChat
                  reportId={reportId}
                  revision={revision}
                  contentHash={contentHash}
                  onReasonChange={setReason}
                />
              ) : null}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

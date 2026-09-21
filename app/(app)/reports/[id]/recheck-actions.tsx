"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { retryRecheckAction, cancelRecheckAction } from "@/app/review/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { refreshReportViews } from "@/lib/reports/live-keys";
import type { RecheckSummary } from "@/lib/reports/recheck-summary";

export function RecheckActions({
  reportId,
  summary,
}: {
  reportId: string;
  summary: RecheckSummary;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<"retry" | "cancel" | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (summary.runReason !== "REVIEWER_GUIDANCE") return null;
  if (summary.runStatus !== "ERROR" && summary.runStatus !== "PENDING") return null;

  const canRetry = summary.runStatus === "ERROR";

  async function confirmAction() {
    if (!confirming || sending) return;

    setSending(true);
    setError(null);
    try {
      const answer =
        confirming === "retry"
          ? await retryRecheckAction(reportId, summary.runId)
          : await cancelRecheckAction(reportId, summary.runId);

      if (!answer.ok) {
        setError(answer.error ?? "The re-check could not be updated.");
        return;
      }

      setConfirming(null);
      await refreshReportViews(queryClient, reportId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The re-check could not be updated.");
    } finally {
      setSending(false);
    }
  }

  function openConfirmation(action: "retry" | "cancel") {
    setError(null);
    setConfirming(action);
  }

  return (
    <>
      <div className="flex flex-wrap gap-2 border-t border-border/50 px-5 py-4">
        {canRetry ? (
          <Button
            size="sm"
            onClick={() => openConfirmation("retry")}
            disabled={sending}
          >
            Retry re-check
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => openConfirmation("cancel")}
          disabled={sending}
        >
          Cancel re-check
        </Button>
      </div>

      <Dialog
        open={confirming !== null}
        onOpenChange={(next) => {
          if (!next && !sending) {
            setConfirming(null);
            setError(null);
          }
        }}
      >
        <DialogContent showCloseButton={false} className="grid-cols-[minmax(0,1fr)]">
          <DialogHeader>
            <DialogTitle>
              {confirming === "retry" ? "Retry this re-check?" : "Cancel this re-check?"}
            </DialogTitle>
            <DialogDescription>
              {confirming === "retry"
                ? "This puts the failed re-check back in the queue. It does not approve anything."
                : "This stops waiting on the re-check and moves the report to Analysis only, where a reviewer decides. The earlier verdict stays superseded."}
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-body text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setConfirming(null)}
              disabled={sending}
            >
              Cancel
            </Button>
            <Button
              variant={confirming === "cancel" ? "destructive" : "default"}
              onClick={() => void confirmAction()}
              loading={sending}
              disabled={sending}
            >
              {confirming === "retry" ? "Retry re-check" : "Cancel re-check"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

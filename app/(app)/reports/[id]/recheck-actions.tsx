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
import {
  recheckActionsFor,
  recheckDialogCopy,
  recheckFailedAnswerError,
  recheckThrownError,
  type RecheckAction,
} from "@/lib/reports/recheck-actions-view";
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
  const actions = recheckActionsFor(summary);
  const runId = summary.runId;

  if (actions.length === 0 || runId === null) return null;

  const canRetry = actions.includes("retry");
  // confirmAction is a hoisted declaration, so TypeScript drops the null check above inside it.
  const targetRunId: string = runId;

  async function confirmAction() {
    if (!confirming || sending) return;

    setSending(true);
    setError(null);
    try {
      const answer =
        confirming === "retry"
          ? await retryRecheckAction(reportId, targetRunId)
          : await cancelRecheckAction(reportId, targetRunId);

      if (!answer.ok) {
        setError(recheckFailedAnswerError(answer));
        return;
      }

      setConfirming(null);
      await refreshReportViews(queryClient, reportId);
    } catch (caught) {
      setError(recheckThrownError(caught));
    } finally {
      setSending(false);
    }
  }

  function openConfirmation(action: RecheckAction) {
    setError(null);
    setConfirming(action);
  }

  const dialogCopy = confirming ? recheckDialogCopy(confirming) : null;

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
            <DialogTitle>{dialogCopy?.title}</DialogTitle>
            <DialogDescription>{dialogCopy?.description}</DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-body text-destructive [overflow-wrap:anywhere]">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setConfirming(null);
                setError(null);
              }}
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

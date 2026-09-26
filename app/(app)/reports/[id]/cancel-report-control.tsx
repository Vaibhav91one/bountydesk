"use client";

import { useState, useTransition } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { cancelReportAction } from "@/app/review/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { refreshReportViews } from "@/lib/reports/live-keys";
import type { CaseLiveView } from "@/lib/reports/case-view";

/**
 * Close a report whose held delivery can never send. Shown on the same condition as the retry
 * control (DELIVERING with a FAILED, held delivery), because both act on the same dead end: retry
 * when the cause is fixable, cancel when it is not. The server re-checks the condition under a row
 * lock, so this button is a convenience, not the guard.
 */
export function CancelReportControl({
  reportId,
  status,
}: {
  reportId: string;
  status: CaseLiveView;
}) {
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const delivery = status.delivery;
  if (
    status.state !== "DELIVERING" ||
    !delivery ||
    delivery.state !== "FAILED" ||
    !delivery.requiresHumanReview
  )
    return null;

  function cancel() {
    setError(null);
    startTransition(async () => {
      const result = await cancelReportAction(reportId);
      if (!result.ok) {
        setError(result.error ?? "Could not cancel the report.");
        return;
      }
      setOpen(false);
      await refreshReportViews(queryClient, reportId);
    });
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border/50 px-5 py-4">
      <Button size="sm" variant="destructive" onClick={() => setOpen(true)}>
        Cancel report
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          setOpen(next);
          if (!next) setError(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Cancel this report?</DialogTitle>
            <DialogDescription>
              The delivery is held and cannot be sent. Cancelling moves the report to CANCELLED and
              closes it. Nothing is sent to the reporter, and this cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="whitespace-normal break-words text-body text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Keep report
            </Button>
            <Button variant="destructive" onClick={cancel} loading={pending} disabled={pending}>
              Cancel report
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

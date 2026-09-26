"use client";

import { useState, useTransition } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { retryHeldDeliveryAction } from "@/app/review/actions";
import { Button } from "@/components/ui/button";
import { refreshReportViews } from "@/lib/reports/live-keys";
import type { CaseLiveView } from "@/lib/reports/case-view";

/**
 * Put a held delivery back in the queue. Shown only while the report is DELIVERING and its delivery
 * is FAILED and held for review; the server re-checks all of that, and the send re-runs every gate.
 */
export function RetryDeliveryControl({
  reportId,
  status,
}: {
  reportId: string;
  status: CaseLiveView;
}) {
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const delivery = status.delivery;
  if (
    status.state !== "DELIVERING" ||
    !delivery ||
    delivery.state !== "FAILED" ||
    !delivery.requiresHumanReview
  )
    return null;

  function retry() {
    setError(null);
    startTransition(async () => {
      const result = await retryHeldDeliveryAction(reportId);
      if (!result.ok) {
        setError(result.error ?? "Could not retry the delivery.");
        return;
      }
      await refreshReportViews(queryClient, reportId);
    });
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border/50 px-5 py-4">
      <p className="whitespace-normal break-words text-meta text-muted-foreground">
        Delivery is held: {delivery.lastError ?? "the send was refused"}. Fix the cause first, then
        retry. The same approved text goes to the same destination, and every send-time check runs
        again.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={retry} loading={pending} disabled={pending}>
          Retry delivery
        </Button>
        {error ? (
          <span className="whitespace-normal break-words text-meta text-destructive">{error}</span>
        ) : null}
      </div>
    </div>
  );
}

"use client";

import { useActionState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";

import { approveOnboarding, type ApproveResult } from "./actions";

export function ApproveOnboardingButton({ repoId }: { repoId: number }) {
  const [result, action, pending] = useActionState<ApproveResult | null, FormData>(
    approveOnboarding,
    null,
  );

  const queryClient = useQueryClient();
  // The list stops polling once nothing is building, and a repo alone in AWAITING_APPROVAL has
  // already stopped it. Refetching after approval shows the row as APPROVED, which restarts polling
  // until verification lands.
  useEffect(() => {
    if (result?.ok) void queryClient.invalidateQueries({ queryKey: ["connections"] });
  }, [result, queryClient]);

  // Approval moves the row out of AWAITING_APPROVAL, and the connections list stops polling once
  // nothing is building, so this sheet would keep showing the button and a second click would
  // report "nothing awaiting approval". Say what happens next instead.
  if (result?.ok) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Approved. The target is being verified offline, and appears once it boots and answers.
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="repoId" value={repoId} />
      <Button type="submit" size="sm" loading={pending}>
        Approve target
      </Button>
      {result && !result.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {result.error}
        </p>
      ) : null}
    </form>
  );
}

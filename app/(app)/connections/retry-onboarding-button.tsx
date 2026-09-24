"use client";

import { useActionState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";

import { retryOnboarding, type RetryResult } from "./actions";

export function RetryOnboardingButton({ repoId }: { repoId: number }) {
  const [result, action, pending] = useActionState<RetryResult | null, FormData>(retryOnboarding, null);

  const queryClient = useQueryClient();
  // A list whose only onboarding is FAILED has stopped polling. Refetching shows the row back in
  // PENDING_PLAN, which restarts polling until the new run settles.
  useEffect(() => {
    if (result?.ok) void queryClient.invalidateQueries({ queryKey: ["connections"] });
  }, [result, queryClient]);

  if (result?.ok) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Onboarding restarted from the beginning.
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-2 pt-2">
      <input type="hidden" name="repoId" value={repoId} />
      <Button type="submit" size="sm" variant="outline" loading={pending}>
        Retry onboarding
      </Button>
      {result && !result.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {result.error}
        </p>
      ) : null}
    </form>
  );
}

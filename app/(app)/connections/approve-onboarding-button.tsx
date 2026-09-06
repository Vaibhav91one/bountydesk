"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import { approveOnboarding, type ApproveResult } from "./actions";

export function ApproveOnboardingButton({ repoId }: { repoId: number }) {
  const [result, action, pending] = useActionState<ApproveResult | null, FormData>(
    approveOnboarding,
    null,
  );

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

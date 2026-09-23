"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import { approveOnboarding, type ApproveResult } from "./actions";

export function ApproveOnboardingButton({ repoId }: { repoId: number }) {
  const [result, action, pending] = useActionState<ApproveResult | null, FormData>(
    approveOnboarding,
    null,
  );

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

"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import { allowVerdict, denyVerdict, type ActionResult } from "./actions";

/**
 * Allow only records a decision and queues it for the submission worker to relay; it never
 * triggers delivery. The report stays in AWAITING_APPROVAL until TrueForge's own
 * publish_verdict tool handler genuinely invokes and moves it, which happens outside this UI.
 */
export function AllowButton({ reportId }: { reportId: string }) {
  const [result, action, pending] = useActionState<ActionResult | null, FormData>(
    () => allowVerdict(reportId),
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-2">
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Allowing…" : "Allow"}
      </Button>
      {result && !result.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {result.error}
        </p>
      ) : null}
    </form>
  );
}

/** A denial is final on bounty-desk's side right away, so it moves the report to DENIED itself. */
export function DenyButton({ reportId }: { reportId: string }) {
  const [result, action, pending] = useActionState<ActionResult | null, FormData>(
    (_previous, formData) => {
      const note = String(formData.get("note") ?? "").trim();
      return denyVerdict(reportId, note.length > 0 ? note : undefined);
    },
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-2">
      <input
        type="text"
        name="note"
        placeholder="Optional note"
        className="h-8 rounded-md border border-border bg-background px-2 text-sm"
      />
      <Button type="submit" size="sm" variant="destructive" disabled={pending}>
        {pending ? "Denying…" : "Deny"}
      </Button>
      {result && !result.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {result.error}
        </p>
      ) : null}
    </form>
  );
}

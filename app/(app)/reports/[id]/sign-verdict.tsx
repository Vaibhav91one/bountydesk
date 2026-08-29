"use client";

import { useActionState } from "react";
import { CheckCircle, Prohibit, Warning } from "@phosphor-icons/react/ssr";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { allowVerdict, denyVerdict, type ActionResult } from "@/app/review/actions";

/**
 * The human gate, and the only control on this page that changes anything.
 *
 * Allow records a decision and queues it for the submission worker to relay; it never posts
 * anything and never moves the report to DELIVERING. That transition happens inside the real
 * publish_verdict handler once TrueForge genuinely invokes it. Deny is final on BountyDesk's
 * side immediately, which is why only it takes a note.
 *
 * The verdict id is passed in, not resolved at click time: a reviewer approves the revision
 * they were shown, and if a new one replaced it since the page rendered, the action refuses
 * rather than approving something nobody read.
 */
export function SignVerdict({
  reportId,
  verdictId,
  contentHash,
}: {
  reportId: string;
  verdictId: string;
  contentHash: string;
}) {
  const [allowed, allow, allowing] = useActionState<ActionResult | null, FormData>(
    () => allowVerdict(reportId, verdictId),
    null,
  );
  const [denied, deny, denying] = useActionState<ActionResult | null, FormData>(
    (_previous, formData) => {
      const note = String(formData.get("note") ?? "").trim();
      return denyVerdict(reportId, verdictId, note.length > 0 ? note : undefined);
    },
    null,
  );

  const done = allowed?.ok || denied?.ok;
  const refusal = (allowed && !allowed.ok && allowed.error) || (denied && !denied.ok && denied.error);

  if (done) {
    return (
      <p
        role="status"
        className="flex items-center gap-2.5 rounded-md bg-emerald-500/10 px-4 py-3 text-body text-emerald-400"
      >
        <CheckCircle className="size-4 shrink-0" />
        {allowed?.ok
          ? "Recorded. The submission worker relays it to the harness; nothing is posted until publish_verdict runs."
          : "Denied. Nothing will be posted, and the report is closed on BountyDesk's side."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Every refusal string comes from the action, which is the thing that actually
          re-reads and locks the rows. Restating them here would be a second opinion. */}
      {refusal ? (
        <p
          role="alert"
          className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-body text-destructive"
        >
          <Warning className="mt-0.5 size-4 shrink-0" />
          <span>
            {refusal}. Nothing was recorded; reload to see the state the database is actually in.
          </span>
        </p>
      ) : null}

      <p className="text-meta text-muted-foreground">
        Approving binds this exact revision and hash. Neither button closes the GitHub issue.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <form action={deny} className="flex flex-1 flex-wrap items-end gap-3">
          <label className="flex min-w-52 flex-1 flex-col gap-1.5">
            <span className="text-meta text-muted-foreground">Reason, if denying</span>
            <Input
              name="note"
              placeholder="Optional, kept on the decision"
              className="h-11 border-border/50 text-body"
            />
          </label>
          <Button type="submit" variant="destructive" loading={denying} disabled={allowing}>
            <Prohibit className="size-4" /> Deny
          </Button>
        </form>

        <form action={allow}>
          <Button type="submit" loading={allowing} disabled={denying}>
            <CheckCircle className="size-4" /> Allow exact comment
          </Button>
        </form>
      </div>

      {/* The hash a reviewer is binding to. break-all because 64 unbroken hex characters
          otherwise set the panel's minimum width and push the page sideways on a phone. */}
      <p className="text-meta font-mono break-all text-muted-foreground">
        <span className="text-muted-foreground/70">sha256 </span>
        {contentHash}
      </p>
    </div>
  );
}

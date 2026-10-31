"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { resolveAppealAction } from "@/app/review/actions";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

export type PanelAppeal = {
  id: string;
  status: string;
  body: string;
  contact: string;
  createdAt: string;
  resolutionNote: string | null;
};

/**
 * Appeals the reporter filed against a delivered verdict. The text is the reporter's own and is
 * rendered as plain text. Acknowledge and close only record status. A delivered report cannot be
 * re-checked, so the reviewer replies to the reporter outside the app and notes it on close.
 *
 * The full list lives in a sheet so the case file stays short. The inline row only carries the count.
 */
export function AppealsPanel({
  reportId,
  appeals,
  appealPath,
}: {
  reportId: string;
  appeals: PanelAppeal[];
  appealPath: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function act(appealId: string, action: "acknowledge" | "close") {
    setPending(appealId);
    setError(null);
    try {
      const result = await resolveAppealAction(reportId, appealId, action, action === "close" ? notes[appealId] : undefined);
      if (!result.ok) setError(result.error ?? "Could not update the appeal.");
      else router.refresh();
    } finally {
      setPending(null);
    }
  }

  const summary =
    appeals.length === 0 ? "No appeals yet" : `${appeals.length} ${appeals.length === 1 ? "appeal" : "appeals"}`;

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-8 py-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-heading text-foreground">Appeals</h2>
        <p className="text-meta text-muted-foreground">{summary}</p>
      </div>
      <Sheet>
        <SheetTrigger render={<Button size="sm" variant="outline" />}>Appeals</SheetTrigger>
        {/* Inline width, not a utility class: the primitive's sm:max-w-sm outranks plain utilities
            (see findings-panel.tsx). Full width on a phone, 32rem beside it. */}
        <SheetContent
          side="right"
          style={{ width: "min(100vw, 32rem)", maxWidth: "min(100vw, 32rem)" }}
          className="gap-0 overflow-y-auto"
        >
          <SheetHeader>
            <SheetTitle>Appeals</SheetTitle>
            <SheetDescription>
              Reporters file an appeal at <a className="underline" href={appealPath}>{appealPath}</a> once a
              verdict is delivered. Send them this link; it is not part of the approved verdict text.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-3 px-6 pb-6">
            {appeals.length === 0 ? <p className="text-meta text-muted-foreground">No appeals yet.</p> : null}
            {appeals.map((item) => (
              <article key={item.id} className="flex flex-col gap-2 rounded-md border border-border/50 p-4">
                <p className="text-meta text-muted-foreground">
                  {item.status} · {item.contact} · {item.createdAt}
                </p>
                <p className="whitespace-pre-wrap break-words text-body text-foreground">{item.body}</p>
                {item.resolutionNote ? (
                  <p className="text-meta text-muted-foreground">Closed: {item.resolutionNote}</p>
                ) : null}
                {item.status !== "CLOSED" ? (
                  <textarea
                    value={notes[item.id] ?? ""}
                    onChange={(event) => setNotes({ ...notes, [item.id]: event.target.value })}
                    placeholder="What you told the reporter (saved when you close)"
                    maxLength={4000}
                    rows={2}
                    className="rounded-md bg-input/50 px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
                  />
                ) : null}
                {item.status !== "CLOSED" ? (
                  <div className="flex gap-2">
                    {item.status === "OPEN" ? (
                      <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void act(item.id, "acknowledge")}>
                        Acknowledge
                      </Button>
                    ) : null}
                    <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void act(item.id, "close")}>
                      Close
                    </Button>
                  </div>
                ) : null}
              </article>
            ))}
            {error ? (
              <p role="alert" className="text-body text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </section>
  );
}

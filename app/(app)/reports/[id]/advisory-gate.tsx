"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { dismissAdvisoryAction, runAnalysisAction } from "@/app/review/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { refreshReportViews } from "@/lib/reports/live-keys";

type Decision = "analysis" | "dismiss";

const COPY: Record<Decision, { title: string; description: string; confirm: string }> = {
  analysis: {
    title: "Run analysis on this advisory?",
    description:
      "Agent Bounty investigates the advisory against its bound target in the sandbox and drafts a verdict. This spends sandbox budget, which is why an advisory waits for you first. The verdict is written back onto the advisory only after you approve it.",
    confirm: "Run analysis",
  },
  dismiss: {
    title: "Dismiss this advisory?",
    description:
      "The report closes as denied and nothing runs on it. Advisories have no reporter mailbox, so no reply is sent; the advisory itself is left untouched.",
    confirm: "Dismiss",
  },
};

/**
 * The reviewer gate for an advisory report.
 *
 * A private vulnerability report can be filed by any GitHub user, so an advisory report waits here
 * before anything runs on it, the same reason an outside email report waits. This is the advisory
 * counterpart of the email TriageGate, kept separate because an advisory has no reporter address,
 * no email triage and no canned replies: the two decisions are to run the analysis or to dismiss it.
 */
export function AdvisoryGate({
  reportId,
  state,
  closingReason,
}: {
  reportId: string;
  state: string;
  closingReason: string | null;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);

  function confirm() {
    if (!decision) return;
    setError(null);
    startTransition(async () => {
      const result =
        decision === "analysis"
          ? await runAnalysisAction(reportId)
          : await dismissAdvisoryAction(reportId);
      if (!result.ok) {
        setError(result.error ?? "Could not record that decision.");
        router.refresh();
        return;
      }
      setDecision(null);
      await refreshReportViews(queryClient, reportId);
      router.refresh();
    });
  }

  const dialog = (
    <Dialog
      open={decision !== null}
      onOpenChange={(next) => {
        if (!next && !pending) {
          setDecision(null);
          setError(null);
        }
      }}
    >
      <DialogContent showCloseButton={false} className="grid-cols-[minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle>{decision ? COPY[decision].title : null}</DialogTitle>
          <DialogDescription>{decision ? COPY[decision].description : null}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-body text-destructive [overflow-wrap:anywhere]">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDecision(null)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={decision === "analysis" ? "default" : "destructive"}
            onClick={confirm}
            loading={pending}
            disabled={pending}
          >
            {decision ? COPY[decision].confirm : null}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );

  if (state !== "NEEDS_DECISION") {
    if (!closingReason) return null;
    return (
      <section className="mx-8 mt-8 flex flex-col gap-4 rounded-xl border border-border/50 bg-card px-5 py-4">
        <p className="text-body text-foreground">{closingReason}</p>
      </section>
    );
  }

  return (
    <section className="mx-8 mt-8 flex flex-col gap-5 rounded-xl border border-border/50 bg-card p-5">
      <header className="flex flex-col gap-1.5">
        <h2 className="text-heading text-foreground">Needs decision</h2>
        <p className="text-body text-muted-foreground">
          This came in as a GitHub security advisory, which any GitHub user can file. Nothing runs on
          it until you decide. Running analysis spends sandbox budget; the verdict is written back
          onto the advisory only after you approve it.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-4">
        <Button size="sm" disabled={pending} onClick={() => setDecision("analysis")}>
          Run analysis
        </Button>
        <Button size="sm" variant="destructive" disabled={pending} onClick={() => setDecision("dismiss")}>
          Dismiss
        </Button>
        {pending ? (
          <span role="status" className="text-meta text-muted-foreground">
            Recording your decision…
          </span>
        ) : null}
      </div>

      {dialog}
    </section>
  );
}

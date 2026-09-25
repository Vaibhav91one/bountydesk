"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { markDuplicateAction, rejectAtGateAction, runAnalysisAction } from "@/app/review/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { refreshReportViews } from "@/lib/reports/live-keys";
import type { GateTriage, GateView } from "@/lib/triage/gate";

type Decision =
  | { kind: "analysis" }
  | { kind: "reject" }
  | { kind: "spam" }
  | { kind: "duplicate"; of: string; title: string | null };

const COPY: Record<Decision["kind"], { title: string; description: string; confirm: string }> = {
  analysis: {
    title: "Run analysis on this report?",
    description:
      "Agent Bounty drafts an analysis-only verdict from the report text, the same run an allowlisted sender gets. Nothing is cloned or started, and the verdict waits for your approval before anything reaches the reporter.",
    confirm: "Run analysis",
  },
  reject: {
    title: "Reject this report?",
    description:
      "The report closes as denied, and the reporter receives a fixed out-of-scope reply saying we reviewed it and will not take it further. Clicking confirm approves that reply. It discloses no reason and names no other report.",
    confirm: "Reject",
  },
  spam: {
    title: "Mark this report as spam?",
    description: "The report closes as denied and is recorded as spam. The sender is sent nothing.",
    confirm: "Mark as spam",
  },
  duplicate: {
    title: "Close as a duplicate?",
    description:
      "The report closes as denied, linked to the original, and the reporter receives the fixed reply saying it duplicates an existing report. Clicking confirm approves that reply. It names no other report.",
    confirm: "Close and send reply",
  },
};

const REPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pull a report id out of a pasted id, a case-file URL, or the short id printed on a case file
 * (`#725dcfed`). A short id is an 8-hex prefix; markDuplicateAction resolves it to the full id
 * server-side, refusing one that names no report or more than one.
 */
function reportIdFrom(value: string): string | null {
  const trimmed = value.trim();
  const full = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (full && REPORT_ID.test(full[0])) return full[0].toLowerCase();
  const short = trimmed.match(/^#?([0-9a-f]{8})$/i);
  return short ? short[1].toLowerCase() : null;
}

/**
 * The badges, summary and linked repositories the email triage produced. Model output about a
 * stranger's text, so it renders as plain text and decides nothing. Shared by the live gate and the
 * collapsed record shown after the report leaves it.
 */
function TriageBody({ triage }: { triage: GateTriage }) {
  return (
    <>
      {triage.triage ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{triage.triage.vulnerabilityClass}</Badge>
            <Badge variant="outline">Likely severity: {triage.triage.severity}</Badge>
            <Badge variant={triage.triage.spamLikelihood === "high" ? "destructive" : "outline"}>
              Spam likelihood: {triage.triage.spamLikelihood}
            </Badge>
          </div>
          <p className="whitespace-pre-wrap text-body text-foreground [overflow-wrap:anywhere]">
            {triage.triage.summary}
          </p>
        </div>
      ) : (
        <p className="text-body text-muted-foreground">The triage did not produce a usable summary.</p>
      )}
      {triage.linkedRepositories.length > 0 ? (
        <p className="text-meta text-muted-foreground [overflow-wrap:anywhere]">
          Linked repositories: {triage.linkedRepositories.join(", ")}
        </p>
      ) : null}
    </>
  );
}

/**
 * The human gate for an outside email report, and the record of a report it closed as a duplicate.
 *
 * Everything shown from the triage is model output about text a stranger wrote, so it renders as
 * plain text and decides nothing. The three decisions are the only way the report moves, and each
 * asks first in the same in-app dialog the approve and re-check actions use.
 */
export function TriageGate({
  reportId,
  state,
  gate,
  closingReason,
}: {
  reportId: string;
  state: string;
  gate: GateView;
  /** Why a denied report was closed (rejected or spam), read from its closing event. Null otherwise. */
  closingReason: string | null;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualId, setManualId] = useState("");

  function confirm() {
    if (!decision) return;
    setError(null);
    startTransition(async () => {
      const result =
        decision.kind === "analysis"
          ? await runAnalysisAction(reportId)
          : decision.kind === "duplicate"
            ? await markDuplicateAction(reportId, decision.of)
            : await rejectAtGateAction(reportId, decision.kind === "spam");
      if (!result.ok) {
        setError(result.error ?? "Could not record that decision.");
        // A duplicate close can commit and still fail to send; the page has to show the new state.
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
          <DialogTitle>{decision ? COPY[decision.kind].title : null}</DialogTitle>
          <DialogDescription>{decision ? COPY[decision.kind].description : null}</DialogDescription>
        </DialogHeader>
        {decision?.kind === "duplicate" ? (
          <p className="text-meta text-muted-foreground [overflow-wrap:anywhere]">
            Original: {decision.title ?? decision.of}
          </p>
        ) : null}
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
            variant={decision?.kind === "analysis" ? "default" : "destructive"}
            onClick={confirm}
            loading={pending}
            disabled={pending}
          >
            {decision ? COPY[decision.kind].confirm : null}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );

  const triage = gate.triage;

  // The report has left the gate. Keep what the gate recorded reachable rather than going blank: why
  // it was closed, what it duplicates, and the initial triage (collapsed, since it is history now).
  if (state !== "NEEDS_DECISION") {
    const original = gate.duplicateOf;
    if (!original && !closingReason && !triage?.triage) return null;
    return (
      <section className="mx-8 mt-8 flex flex-col gap-4 rounded-xl border border-border/50 bg-card px-5 py-4">
        {original ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-body text-foreground">
              Closed as a duplicate of{" "}
              <Link href={`/reports/${original.id}`} className="underline underline-offset-4">
                {original.title}
              </Link>
              . {gate.duplicateReplySent ? "The duplicate reply was sent." : "The duplicate reply has not been sent."}
            </p>
            {gate.duplicateReplySent ? null : (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => setDecision({ kind: "duplicate", of: original.id, title: original.title })}
              >
                Send the reply again
              </Button>
            )}
          </div>
        ) : closingReason ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-body text-foreground">
              {closingReason}
              {gate.rejectReplySent === null
                ? ""
                : gate.rejectReplySent
                  ? " The reply was sent."
                  : " The reply has not been sent."}
            </p>
            {gate.rejectReplySent === false ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => setDecision({ kind: "reject" })}
              >
                Send the reply again
              </Button>
            ) : null}
          </div>
        ) : null}
        {triage?.triage ? (
          <details>
            <summary className="cursor-pointer text-meta text-muted-foreground">Initial triage</summary>
            <div className="mt-3 flex flex-col gap-3">
              <TriageBody triage={triage} />
            </div>
          </details>
        ) : null}
        {dialog}
      </section>
    );
  }

  const manual = reportIdFrom(manualId);

  return (
    <section className="mx-8 mt-8 flex flex-col gap-5 rounded-xl border border-border/50 bg-card p-5">
      <header className="flex flex-col gap-1.5">
        <h2 className="text-heading text-foreground">Needs decision</h2>
        <p className="text-body text-muted-foreground">
          This report came from an outside sender
          {gate.verifiedSender ? ` (${gate.verifiedSender}, SPF and DKIM passed)` : ""}. It has had a
          light triage of the email alone. Nothing else runs on it until you decide.
        </p>
      </header>

      {triage ? (
        <TriageBody triage={triage} />
      ) : (
        <p className="text-body text-muted-foreground">Triage has not finished yet.</p>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-meta text-muted-foreground">Possible duplicates</h3>
        {triage && triage.duplicateCandidates.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {triage.duplicateCandidates.map((candidate) => (
              <li key={candidate.reportId} className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  href={`/reports/${candidate.reportId}`}
                  className="min-w-0 truncate text-body text-foreground underline-offset-4 hover:underline"
                >
                  {candidate.title}
                </Link>
                <span className="flex items-center gap-2">
                  <Badge variant="outline">{Math.round(candidate.score * 100)}% similar</Badge>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      setDecision({ kind: "duplicate", of: candidate.reportId, title: candidate.title })
                    }
                  >
                    Mark duplicate
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-meta text-muted-foreground">No similar reports found.</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={manualId}
            onChange={(event) => setManualId(event.target.value)}
            placeholder="Or paste a report id, link, or short id"
            aria-label="Original report id"
            disabled={pending}
            className="max-w-sm"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!manual || manual === reportId || pending}
            onClick={() => manual && setDecision({ kind: "duplicate", of: manual, title: null })}
          >
            Mark duplicate
          </Button>
        </div>
        {/* The button silently disabling on an unrecognized value reads as broken, so say what a
            recognized value is once the box holds something that is not one. */}
        {manualId.trim() && !manual ? (
          <p className="text-meta text-muted-foreground">
            Enter a full report id, a case-file link, or the 8-character short id shown as #xxxxxxxx.
          </p>
        ) : null}
      </div>

      {/* The row lock already stops a real double action; disabling here is so a confirmed decision
          does not leave the old buttons live and unmarked while the new state is still loading. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-4">
        <Button size="sm" disabled={pending} onClick={() => setDecision({ kind: "analysis" })}>
          Run analysis
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => setDecision({ kind: "reject" })}>
          Reject
        </Button>
        <Button size="sm" variant="destructive" disabled={pending} onClick={() => setDecision({ kind: "spam" })}>
          Mark as spam
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

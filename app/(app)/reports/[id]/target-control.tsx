"use client";

import { useState, useTransition } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { bindTargetAction, requestRecheckAction } from "@/app/review/actions";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { refreshReportViews } from "@/lib/reports/live-keys";
import type { CaseLiveView } from "@/lib/reports/case-view";
import type { TargetProfileOption } from "@/lib/targets/bind";

/**
 * The bound target, and what a reviewer can do about it.
 *
 * A report that arrived through GitHub inherits its target from the repository the issue was
 * filed on, so this only ever offers a choice for one that arrived without one: email today,
 * upload later. Until a target is bound, `assertVerdictInsertAllowed` permits nothing but
 * ANALYSIS_ONLY, which is why such a report can be triaged and then goes nowhere.
 *
 * Reproduce is deliberately not gated on the agent's own opinion of whether the report looks
 * reproducible. That opinion is advisory, it is drafted from the report text alone when no
 * target was bound, and a reviewer who binds a target is the one authorising the attempt.
 */
export function TargetControl({
  reportId,
  status,
  profiles,
}: {
  reportId: string;
  status: CaseLiveView;
  /** Built target profiles, read server-side. A reviewer never types a target. */
  profiles: TargetProfileOption[];
}) {
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  if (status.target) {
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="truncate text-body text-foreground">{status.target.name}</span>
        <ReproduceButton reportId={reportId} status={status} />
      </div>
    );
  }

  // Nothing to pick from is a deployment fact, not a reviewer's problem to solve here.
  if (profiles.length === 0) {
    return <span className="truncate text-body text-foreground">None bound</span>;
  }

  // A report on its way out, or already closed, is not one to bind. bindTarget refuses these
  // server-side too; this only keeps the control from inviting an action that cannot work.
  const bindable = status.state !== "DELIVERING" && !TERMINAL.includes(status.state);
  if (!bindable) {
    return <span className="truncate text-body text-foreground">None bound</span>;
  }

  function bind() {
    if (!choice) return;
    setError(null);
    startTransition(async () => {
      const result = await bindTargetAction(reportId, choice);
      if (!result.ok) {
        setError(result.error ?? "Could not bind that target.");
        return;
      }
      refreshReportViews(queryClient, reportId);
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={choice} onValueChange={(value) => setChoice(value ?? "")} disabled={pending}>
          <SelectTrigger size="sm" className="min-w-40">
            <SelectValue placeholder="None bound" />
          </SelectTrigger>
          <SelectContent>
            {profiles.map((profile) => (
              <SelectItem key={profile.id} value={profile.id}>
                {profile.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={bind} disabled={!choice || pending}>
          {pending ? "Binding…" : "Bind"}
        </Button>
      </div>
      {error ? <span className="text-meta text-destructive">{error}</span> : null}
    </div>
  );
}

const TERMINAL = ["DELIVERED", "DENIED", "OUT_OF_SCOPE", "CANCELLED", "EXPIRED"];

/**
 * Start a reproduction run against the bound target.
 *
 * This is `requestRecheck` under a different name, which is the whole reason it is cheap: the
 * report is already ANALYSIS_ONLY with a parked verdict, ANALYSIS_ONLY to REPRODUCING is already
 * a legal move, and the continuation worker re-reads the target when it claims the job. The
 * difference from a re-check is when it is offered and what it is called, not the machinery.
 */
function ReproduceButton({ reportId, status }: { reportId: string; status: CaseLiveView }) {
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Only a report parked on an analysis-only verdict. requestRecheck refuses anything else, and
  // a NOT_REPRODUCED report keeps "Ask to re-check" on the verdict card instead.
  const offerable =
    status.state === "ANALYSIS_ONLY" &&
    status.awaitingVerdictId !== null &&
    status.verdict?.outcome === "ANALYSIS_ONLY" &&
    !status.investigating;

  if (!offerable) return null;
  const verdictId = status.awaitingVerdictId;

  function reproduce() {
    if (!verdictId) return;
    setError(null);
    startTransition(async () => {
      const result = await requestRecheckAction(reportId, verdictId);
      if (!result.ok) {
        setError(result.error ?? "Could not start a reproduction run.");
        return;
      }
      refreshReportViews(queryClient, reportId);
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <Button size="sm" variant="outline" onClick={reproduce} disabled={pending}>
        {pending ? "Starting…" : "Reproduce"}
      </Button>
      {error ? <span className="text-meta text-destructive">{error}</span> : null}
    </div>
  );
}

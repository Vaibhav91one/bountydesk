"use client";

import { useState, useTransition } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info } from "@phosphor-icons/react/ssr";

import { bindTargetAction, requestRecheckAction } from "@/app/review/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { refreshReportViews } from "@/lib/reports/live-keys";
import { fetchLive } from "@/lib/reports/status-query";
import type { CaseLiveView } from "@/lib/reports/case-view";
import type { TargetProfileOption } from "@/lib/targets/bind";
import type { TargetSuggestion } from "@/lib/targets/suggest";

import { ConnectGuide } from "./connect-guide";

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
  profiles: initialProfiles,
  suggestion: initialSuggestion,
}: {
  reportId: string;
  status: CaseLiveView;
  /** Built target profiles, read server-side. A reviewer never types a target. */
  profiles: TargetProfileOption[];
  /** Targets matched from the repository links in an email report's body. */
  suggestion: TargetSuggestion | null;
}) {
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [guideFor, setGuideFor] = useState<string | null>(null);
  // The open guide's link is part of the request because only that link is checked on GitHub for
  // a fork not connected yet. Switching links keeps showing the last answer until the new one lands.
  const initial = { profiles: initialProfiles, suggestion: initialSuggestion };
  const { data = initial } = useQuery({
    queryKey: ["report-targets", reportId, guideFor],
    queryFn: () =>
      fetchLive<{ profiles: TargetProfileOption[]; suggestion: TargetSuggestion | null }>(
        `/api/reports/${reportId}/targets${guideFor ? `?guide=${encodeURIComponent(guideFor)}` : ""}`,
      ),
    initialData: guideFor ? undefined : initial,
    placeholderData: keepPreviousData,
    // The suggestion is loaded here rather than at server render, so it starts null and the fetch
    // on mount fills it. Poll only while the report names a repository not ready yet, read off the
    // fetched data so a fork that finishes onboarding appears in the picker without a reload.
    refetchInterval: (query) => {
      if (status.target) return false;
      const suggestion = (query.state.data ?? initial).suggestion;
      return (suggestion?.unconnected.length ?? 0) > 0 ? 5000 : false;
    },
  });
  const { profiles, suggestion } = data;
  // Binding authorises execution against a target, so it never happens without a click on Bind,
  // and the picker is never pre-filled with an arbitrary first profile. The one exception is a
  // target matched from a link in the report, and that choice is labelled with the link it came
  // from (in a tooltip beside the picker), so it cannot be a default nobody noticed. null is
  // base-ui's own "nothing selected".
  const suggested =
    suggestion?.matched.find((match) => profiles.some((profile) => profile.id === match.profileId)) ??
    null;
  // What the reviewer picked, else the suggestion. Derived rather than seeded once, so a target
  // that becomes ready while the page is open is selected too.
  const [picked, setChoice] = useState<string | null>(null);
  const choice = picked ?? suggested?.profileId ?? null;
  // A target that only shares a repository name with a link GitHub has nothing at. That is as
  // likely a private or unrelated repository as a renamed one, so it is named here and the picker
  // stays empty: the reviewer has to choose it.
  const possible = suggested
    ? null
    : (suggestion?.possibleMatches ?? []).find((match) => profiles.some((profile) => profile.id === match.profileId)) ??
      null;
  const [error, setError] = useState<string | null>(null);

  const guide =
    guideFor && suggestion ? (
      <ConnectGuide
        upstream={guideFor}
        choices={suggestion.unconnected}
        onChoose={setGuideFor}
        progress={suggestion.progress.find((p) => p.name === guideFor) ?? null}
        connectLinks={suggestion.connectLinks}
        open
        onOpenChange={(next) => !next && setGuideFor(null)}
      />
    ) : null;

  if (status.target) {
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="truncate text-body text-foreground">{status.target.name}</span>
        <ReproduceButton reportId={reportId} status={status} targetName={status.target.name} />
      </div>
    );
  }

  // A report on its way out, or already closed, is not one to bind. bindTarget refuses these
  // server-side too; this only keeps the control from inviting an action that cannot work.
  const bindable = status.state !== "DELIVERING" && !TERMINAL.includes(status.state);
  if (!bindable) {
    return <span className="truncate text-body text-foreground">None bound</span>;
  }

  // Nothing to pick from. The report may still name a repository that could become a target.
  if (profiles.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="truncate text-body text-foreground">None bound</span>
        {suggestion?.unconnected.length ? (
          <ConnectButton onClick={() => setGuideFor(suggestion.unconnected[0])} />
        ) : null}
        {guide}
      </div>
    );
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
        {/* items is what teaches the trigger to print the profile's name rather than the uuid it
            is storing: without it the reviewer reads back an id, not the target they chose. */}
        <Select
          items={profiles.map((profile) => ({ label: profile.name, value: profile.id }))}
          value={choice}
          onValueChange={setChoice}
          disabled={pending}
        >
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
        {suggested && choice === suggested.profileId ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex text-muted-foreground" aria-label={suggestionNote(suggested)} />
              }
            >
              <Info className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{suggestionNote(suggested)}</TooltipContent>
          </Tooltip>
        ) : null}
        <Button size="sm" onClick={bind} disabled={!choice || pending}>
          {pending ? "Binding…" : "Bind"}
        </Button>
        {/* Nothing matched, so the report names a repository we cannot reproduce against yet. */}
        {!suggested && suggestion?.unconnected.length ? (
          <ConnectButton onClick={() => setGuideFor(suggestion.unconnected[0])} />
        ) : null}
      </div>
      {possible ? (
        <span className="whitespace-normal break-words text-meta text-muted-foreground">
          Possible match by name: {possible.profileName} ({possible.fullName}). {possible.mention} was not
          found on GitHub, so it may be renamed, private or a different project.
        </span>
      ) : null}
      {guide}
      {error ? <span className="whitespace-normal break-words text-meta text-destructive">{error}</span> : null}
    </div>
  );
}

/** Why the picker opened on this target, so a suggestion is never a default nobody can explain. */
function suggestionNote(match: TargetSuggestion["matched"][number]): string {
  const link = match.canonical ? `${match.mention} (now ${match.canonical})` : match.mention;
  return match.via === "fork"
    ? `Suggested because the report links ${link}, and its fork ${match.fullName} is connected`
    : `Suggested because the report links ${link}`;
}

function ConnectButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="sm" variant="outline" onClick={onClick}>
      Connect
    </Button>
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
function ReproduceButton({
  reportId,
  status,
  targetName,
}: {
  reportId: string;
  status: CaseLiveView;
  targetName: string;
}) {
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Reproducing executes against the target, so it asks first, in the same in-app confirmation
  // the approve, deny and re-check actions use.
  const [confirming, setConfirming] = useState(false);

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
      setConfirming(false);
      refreshReportViews(queryClient, reportId);
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
        Reproduce
      </Button>
      <Dialog open={confirming} onOpenChange={(next) => !pending && setConfirming(next)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Reproduce against {targetName}?</DialogTitle>
            <DialogDescription>
              Agent Bounty starts {targetName} from its pinned image in an isolated sandbox and
              probes only that target. The run ends in a new verdict that waits for your approval;
              nothing reaches the reporter until you sign it.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <span className="whitespace-normal break-words text-meta text-destructive">{error}</span>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={reproduce} loading={pending} disabled={pending}>
              Reproduce
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

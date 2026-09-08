"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowSquareOut, Check, CheckCircle, CircleNotch, Prohibit, Warning } from "@phosphor-icons/react/ssr";
import { GitHubLight } from "developer-icons";

import { formatStamp } from "@/lib/format";

import { RollingIcon } from "@/components/rolling-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

import { ApproveOnboardingButton } from "./approve-onboarding-button";
import { DownloadArtifact } from "./download-artifact";
import { OnboardingDialog, type OnboardingTab } from "./onboarding-dialog";
import { onboardingView } from "./onboarding-steps";
import type { RepositoryRow } from "./connection-tabs";
import type { OnboardingDetail } from "@/lib/github/connections";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/50 py-2.5 last:border-b-0">
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-meta text-foreground">{children}</dd>
    </div>
  );
}

/** A repository that has sent nothing yet says so, rather than showing a bare zero. */
function count(n: number, noun: string): string {
  if (n === 0) return `No ${noun}s`;
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

/**
 * The button into the onboarding dialog, reading the current state rather than always saying the same
 * thing: onboarded reads as done and green, a live onboarding as amber and in progress, and the two
 * terminal misses (failed, unsupported) in their own colours. onboardingView's terminal bucket is the
 * same one the dialog's stepper keys off, so the button and the view it opens never disagree.
 */
function OnboardingButton({ state, onOpen }: { state: string; onOpen: () => void }) {
  const { terminal } = onboardingView(state);
  const view =
    terminal === "configured"
      ? { label: "Onboarded", icon: <Check weight="bold" />, className: "bg-phase-delivered text-background hover:bg-phase-delivered/90" }
      : terminal === "failed"
        ? { label: "Onboarding failed", icon: <Warning weight="fill" />, className: "bg-destructive text-white hover:bg-destructive/90" }
        : terminal === "unsupported"
          ? { label: "Can't be onboarded", icon: <Prohibit weight="fill" />, className: "bg-phase-closed text-background hover:bg-phase-closed/90" }
          : { label: "Onboarding…", icon: <CircleNotch weight="bold" className="animate-spin" />, className: "bg-phase-approval text-background hover:bg-phase-approval/90" };

  return (
    <Button className={`w-full justify-center ${view.className}`} onClick={onOpen}>
      {view.icon} {view.label}
    </Button>
  );
}

/** Plain-language heading for where onboarding is, or why it stopped. A live progress note from the
 *  worker or the build tools wins, so a multi-minute agent turn reads as its real activity instead of
 *  one static "Classifying". */
function onboardingProgressLabel(state: string, progressNote?: string | null): string {
  if (progressNote && progressNote.trim().length > 0) {
    return progressNote.charAt(0).toUpperCase() + progressNote.slice(1);
  }
  switch (state) {
    case "PENDING_PLAN":
      return "Reading the repository";
    case "PENDING_BUILD":
      return "Building the target image";
    case "PENDING_MANIFEST":
      return "Preparing the target manifest";
    case "FAILED":
      return "Onboarding failed";
    case "UNSUPPORTED":
      return "This repository cannot be onboarded";
    default:
      return "Onboarding in progress";
  }
}

/** The onboarding record: what was built, the sandboxability verdict, the approver, and downloads.
 *  Shown for any onboarding state, so a CONFIGURED target reads as onboarded rather than as an absence
 *  of progress. */
function OnboardingRecord({
  repoId,
  detail,
  configured,
}: {
  repoId: number;
  detail: OnboardingDetail;
  configured: boolean;
}) {
  const image = detail.imageName
    ? detail.imageName + (detail.imageDigest ? `@${detail.imageDigest}` : "")
    : null;
  const hasDownloads = detail.hasDockerfile || detail.hasManifest || detail.hasBuildPlan || detail.hasBuildLog;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        {configured ? <CheckCircle className="size-4 shrink-0 text-emerald-400" /> : null}
        <p className="text-meta font-medium text-foreground">
          {configured ? "Onboarded as a reproduction target" : "Onboarding record"}
        </p>
      </div>
      <dl className="flex flex-col">
        {detail.strategy ? (
          <Row label="Build strategy">
            {detail.strategy}
            {detail.ecosystem ? ` · ${detail.ecosystem}` : ""}
          </Row>
        ) : null}
        {image ? (
          <Row label="Image">
            <span className="break-all font-mono text-xs">{image}</span>
          </Row>
        ) : null}
        {detail.buildMarker ? (
          <Row label="Source commit">
            <span className="font-mono text-xs">{detail.buildMarker.slice(0, 12)}</span>
          </Row>
        ) : null}
        {detail.review ? (
          <Row label="Sandboxability">
            {detail.review.verdict}
            {detail.review.reason ? ` · ${detail.review.reason}` : ""}
          </Row>
        ) : null}
        {detail.reason ? <Row label="Reason">{detail.reason}</Row> : null}
        {detail.approvedBy ? (
          <Row label="Approved by">
            {detail.approvedBy}
            {detail.approvedAt ? ` · ${formatStamp(new Date(detail.approvedAt))}` : ""}
          </Row>
        ) : null}
      </dl>
      {hasDownloads ? (
        <div className="flex flex-col gap-2">
          <p className="text-meta text-muted-foreground">Downloads</p>
          {detail.hasDockerfile ? <DownloadArtifact repoId={repoId} kind="dockerfile" label="Dockerfile" /> : null}
          {detail.hasManifest ? <DownloadArtifact repoId={repoId} kind="manifest" label="Target manifest" /> : null}
          {detail.hasBuildPlan ? <DownloadArtifact repoId={repoId} kind="buildplan" label="Build plan" /> : null}
          {detail.hasBuildLog ? <DownloadArtifact repoId={repoId} kind="buildlog" label="Build log" /> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One repository, without leaving the list.
 *
 * The table says whether a report opened here would be accepted; this says why, what the
 * repository has actually sent, and gives the control that changes it. Everything shown comes
 * from the row the table already has, so it opens instantly: a repository has no detail page
 * to be a summary of.
 *
 * Which panel is open is a URL parameter, so this is linkable. That is the whole reason the
 * fields here are the ones a person recognises (an owner, a repository, a count of reports)
 * rather than the ids the database joins on: the link gets pasted to someone who has to be
 * able to tell what it points at.
 */
export function RepositorySheet({
  repo,
  onOpenChange,
}: {
  repo: RepositoryRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  // Which onboarding view the dialog is open on, or null when it is closed. Both buttons open the
  // same dialog and only pick the starting tab; the toggle inside then switches freely.
  const [dialogTab, setDialogTab] = useState<OnboardingTab | null>(null);

  return (
    <Sheet open={repo !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="no-scrollbar gap-0 overflow-y-auto sm:max-w-md">
        {repo ? (
          <>
            <SheetHeader className="gap-3 border-b border-border/50 p-6">
              <SheetTitle className="flex items-start gap-2.5 text-title">
                <GitHubLight className="mt-1 size-5 shrink-0" />
                <span className="min-w-0 flex-1 break-all">{repo.fullName}</span>
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <Badge variant={repo.connected ? "success" : "outline"}>{repo.label}</Badge>
                <span className="text-meta">{repo.account}</span>
              </SheetDescription>
            </SheetHeader>

            <div className="flex flex-col gap-5 p-6">
              <p
                className={
                  repo.connected
                    ? "flex items-start gap-2.5 rounded-md bg-emerald-500/10 px-4 py-3 text-body text-emerald-400"
                    : "flex items-start gap-2.5 rounded-md border border-border/50 px-4 py-3 text-body text-muted-foreground"
                }
              >
                {repo.connected ? (
                  <CheckCircle className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <Warning className="mt-0.5 size-4 shrink-0" />
                )}
                {repo.hint}
              </p>

              <dl className="flex flex-col">
                <Row label="Owner">{repo.owner}</Row>
                <Row label="Repository">{repo.name}</Row>
                <Row label="Installed by">{repo.account}</Row>
                <Row label="Bound target">{repo.target ?? "None bound"}</Row>
                <Row label="Reports received">{count(repo.reportCount, "report")}</Row>
                {/* Only where there is something to act on. A permanent "0 waiting" is a row
                    a reader has to check every time to learn nothing. */}
                {repo.awaitingReview > 0 ? (
                  <Row label="Waiting on a reviewer">
                    <Link
                      href="/board"
                      className="text-brand-soft underline underline-offset-4"
                    >
                      {count(repo.awaitingReview, "report")}
                    </Link>
                  </Row>
                ) : null}
                <Row label="Verdicts delivered">{repo.delivered}</Row>
                <Row label="Last report">
                  {repo.lastReportAt ? formatStamp(new Date(repo.lastReportAt)) : "None yet"}
                </Row>
                <Row label="Last change from GitHub">
                  {formatStamp(new Date(repo.lastSyncedAt))}
                </Row>
              </dl>

              {/* The one human gate on onboarding. A worker cannot cross AWAITING_APPROVAL on
                  its own, so this is the only path from a proposed manifest to a written target,
                  and the reviewer approves a specific build (name and digest), not just a name. */}
              {repo.onboarding ? (
                <div className="flex flex-col gap-3 rounded-md border border-border/60 bg-muted/30 p-3">
                  <div className="flex flex-col gap-0.5">
                    <p className="text-meta font-medium text-foreground">
                      Proposed target awaiting approval
                    </p>
                    <p className="text-sm text-muted-foreground">
                      A build finished and proposed this manifest. Approving it writes the target
                      profile and opens reproduction for this repository.
                    </p>
                  </div>
                  <dl className="flex flex-col">
                    <Row label="Name">{repo.onboarding.manifest.name}</Row>
                    <Row label="Image">
                      <span className="break-all font-mono text-xs">
                        {(repo.onboarding.imageName ?? repo.onboarding.manifest.imageName) +
                          (repo.onboarding.imageDigest
                            ? `@${repo.onboarding.imageDigest}`
                            : "")}
                      </span>
                    </Row>
                    <Row label="Base URL">{repo.onboarding.manifest.baseUrl}</Row>
                    <Row label="Readiness path">{repo.onboarding.manifest.readinessPath}</Row>
                    {repo.onboarding.manifest.startCommand ? (
                      <Row label="Start command">
                        <span className="break-all font-mono text-xs">
                          {repo.onboarding.manifest.startCommand}
                        </span>
                      </Row>
                    ) : null}
                  </dl>
                  <ApproveOnboardingButton repoId={repo.repoId} />
                </div>
              ) : null}

              {/* Onboarding that is in flight or refused. A reviewer sees "building" rather than an
                  idle panel, and an honest reason when a repo cannot become one offline image. */}
              {repo.onboardingProgress ? (
                <div
                  className={
                    repo.onboardingProgress.state === "UNSUPPORTED" ||
                    repo.onboardingProgress.state === "FAILED"
                      ? "flex flex-col gap-1 rounded-md border border-border/50 px-4 py-3 text-body text-muted-foreground"
                      : "flex flex-col gap-1 rounded-md bg-muted/30 px-4 py-3 text-body text-muted-foreground"
                  }
                >
                  <span className="text-meta font-medium text-foreground">
                    {onboardingProgressLabel(repo.onboardingProgress.state, repo.onboardingDetail?.progressNote)}
                  </span>
                  {repo.onboardingProgress.reason ? (
                    <span className="text-sm">{repo.onboardingProgress.reason}</span>
                  ) : null}
                </div>
              ) : null}

              {/* What onboarding did: the recipe, the built image, the sandboxability verdict, the
                  approver, and downloads. Shown whenever an onboarding record exists, so a CONFIGURED
                  target has a positive "this is onboarded" answer, not just an absence of progress. */}
              {repo.onboardingDetail &&
              !["PENDING_PLAN", "PENDING_BUILD", "PENDING_MANIFEST"].includes(repo.onboardingDetail.state) ? (
                <OnboardingRecord repoId={repo.repoId} detail={repo.onboardingDetail} configured={repo.configured} />
              ) : null}

              {repo.onboardingDetail ? (
                <OnboardingButton state={repo.onboardingDetail.state} onOpen={() => setDialogTab("state")} />
              ) : null}

              <OnboardingDialog
                open={dialogTab !== null}
                tab={dialogTab ?? "state"}
                onTabChange={setDialogTab}
                onOpenChange={(next) => !next && setDialogTab(null)}
                repositoryFullName={repo.fullName}
                state={repo.onboardingDetail?.state ?? null}
              />

              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={
                    <a
                      href={`https://github.com/${repo.fullName}`}
                      target="_blank"
                      rel="noreferrer noopener"
                    />
                  }
                  className="w-full justify-center"
                >
                  <RollingIcon icon={GitHubLight} className="size-4" /> Open on GitHub
                  <ArrowSquareOut className="size-3.5" />
                </Button>

                {/* Where reports come from, so it is one click from the panel that counts
                    them. */}
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={
                    <a
                      href={`https://github.com/${repo.fullName}/issues`}
                      target="_blank"
                      rel="noreferrer noopener"
                    />
                  }
                  className="w-full justify-center"
                >
                  Issues on GitHub
                  <ArrowSquareOut className="size-3.5" />
                </Button>

                {/* Which repositories the App can see is GitHub's screen, not ours: a GitHub
                    App cannot change its own repository selection, so taking access away
                    happens there and reaches us afterwards as a webhook. */}
                {repo.manageUrl ? (
                  <Button
                    variant="outline"
                    nativeButton={false}
                    render={
                      <a href={repo.manageUrl} target="_blank" rel="noreferrer noopener" />
                    }
                    className="w-full justify-center"
                  >
                    Manage access on GitHub
                    <ArrowSquareOut className="size-3.5" />
                  </Button>
                ) : null}
              </div>

              <Button
                variant="ghost"
                nativeButton={false}
                render={<Link href="/integrations/github" />}
                className="w-full justify-center"
              >
                About the GitHub integration
              </Button>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

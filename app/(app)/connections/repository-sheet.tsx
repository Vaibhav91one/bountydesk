"use client";

import Link from "next/link";
import { ArrowSquareOut, CheckCircle, Warning } from "@phosphor-icons/react/ssr";
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

import { ConfigureButton } from "../integrations/configure-button";
import type { RepositoryRow } from "./connection-tabs";

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

              {/* The same control the row carries, so the two cannot drift apart. */}
              <ConfigureButton
                repoId={repo.repoId}
                configured={repo.configured}
                label={repo.configured ? "Reconfigure" : "Configure"}
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

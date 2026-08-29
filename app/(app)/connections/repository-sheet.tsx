"use client";

import Link from "next/link";
import { ArrowSquareOut, CheckCircle, Warning } from "@phosphor-icons/react/ssr";
import { GitHubLight } from "developer-icons";

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

/**
 * One repository, without leaving the list.
 *
 * The table says whether a report opened here would be accepted; this says why, and gives the
 * two controls that change it. Everything shown is already in the row, so it opens instantly
 * and reads nothing further: a repository has no detail page to be a summary of.
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
                <Row label="Account">{repo.account}</Row>
                <Row label="Bound target">{repo.target ?? "None bound"}</Row>
                <Row label="Repository id">
                  <span className="font-mono">{repo.repoId}</span>
                </Row>
                <Row label="Accepting reports">{repo.connected ? "Yes" : "No"}</Row>
              </dl>

              {/* The same control the row carries, so the two cannot drift apart. */}
              <ConfigureButton
                repoId={repo.repoId}
                configured={repo.configured}
                label={repo.configured ? "Reconfigure" : "Configure"}
              />

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

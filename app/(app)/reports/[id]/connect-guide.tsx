"use client";

import Link from "next/link";
import { ArrowSquareOut } from "@phosphor-icons/react/ssr";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { StepState } from "@/lib/reports/case-view";
import type { MentionProgress, TargetSuggestion } from "@/lib/targets/suggest";
import { cn } from "@/lib/utils";

import { StepBadge } from "./lifecycle-step";

/**
 * How a reviewer gets from "the report links a repository we do not hold" to a target it can be
 * reproduced against.
 *
 * Reproduction only ever runs against a target the server holds, and a target comes from a
 * repository the owner connected and a reviewer onboarded. So the path is the owner's: fork the
 * upstream into an account the App is installed on, add the fork to the installation (which
 * starts onboarding), approve its manifest. Forking is a link to GitHub's own fork page rather
 * than an API call, because creating a repository would need a far wider grant than the App has.
 */
export function ConnectGuide({
  upstream,
  progress,
  connectLinks,
  open,
  onOpenChange,
}: {
  upstream: string;
  /** Where the linked repository stands now, re-read while the guide is open. */
  progress: MentionProgress | null;
  connectLinks: TargetSuggestion["connectLinks"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const status = progress?.status ?? "not-connected";
  const connected = status !== "not-connected";
  const ready = status === "ready";
  const stopped = status === "failed" || status === "unsupported";
  const fork = progress?.repoFullName ?? null;
  const repoHref = fork ? `/connections?repo=${encodeURIComponent(fork)}` : "/connections";

  const onboardNote: Record<string, React.ReactNode> = {
    onboarding: progress?.retrying ? (
      <>
        Onboarding is building the fork, and its last attempt failed, so it will retry:{" "}
        <span className="text-destructive">{progress.retrying}</span>
      </>
    ) : (
      "Onboarding is building the fork in a sandbox. This takes a few minutes."
    ),
    "awaiting-approval": "Onboarding proposed how to run it. Approve the manifest to create the target.",
    failed: <span className="text-destructive">Onboarding failed: {progress?.reason ?? "no reason recorded"}.</span>,
    unsupported: (
      <span className="text-destructive">
        It cannot be onboarded: {progress?.reason ?? "no reason recorded"}. This report stays analysis only.
      </span>
    ),
  };

  const steps: { state: StepState; title: string; body: React.ReactNode }[] = [
    {
      state: connected ? "done" : "current",
      title: "Fork it",
      body: connected ? (
        fork && fork.toLowerCase() !== upstream.toLowerCase() ? `Forked as ${fork}.` : `${upstream} is connected.`
      ) : (
        <>
          Fork {upstream} into an account BountyDesk is installed on.{" "}
          <ExternalLink href={`https://github.com/${upstream}/fork`}>Fork on GitHub</ExternalLink>
        </>
      ),
    },
    {
      state: connected ? "done" : "pending",
      title: "Add the fork to BountyDesk",
      body: connected ? (
        `${fork} is connected, and onboarding has started.`
      ) : (
        <>
          Give the App access to the fork. Onboarding starts on its own once it is added.{" "}
          {connectLinks.map((link) => (
            <ExternalLink key={link.href} href={link.href}>
              {connectLinks.length > 1 ? `Manage ${link.account}` : "Manage repositories"}
            </ExternalLink>
          ))}
        </>
      ),
    },
    {
      state: ready ? "done" : stopped ? "skipped" : connected ? "current" : "pending",
      title: "Approve its manifest",
      body: ready ? (
        "The target is built and approved."
      ) : (
        <>
          {onboardNote[status] ?? "BountyDesk builds the fork in a sandbox and proposes how to run it."}{" "}
          <Link href={repoHref} className="text-foreground underline-offset-4 hover:underline">
            Open on Connections
          </Link>
        </>
      ),
    },
    {
      state: ready ? "current" : "pending",
      title: "Bind and reproduce",
      body: "The new target appears in the picker, already selected. Bind it, then Reproduce.",
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Right padding keeps the description clear of the dialog's close button. */}
        <DialogHeader className="pr-10">
          <DialogTitle>Reproduce against {upstream}</DialogTitle>
          <DialogDescription>
            BountyDesk only reproduces against repositories that are connected and onboarded. Each step
            below updates on its own as it completes.
          </DialogDescription>
        </DialogHeader>
        <ol className="flex flex-col">
          {steps.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <div className="flex flex-col items-center">
                <StepBadge state={step.state} index={i + 1} />
                {i < steps.length - 1 ? (
                  <span className={cn("w-0.5 flex-1", step.state === "done" ? "bg-phase-delivered" : "bg-border")} />
                ) : null}
              </div>
              <div className="flex min-w-0 flex-col gap-1 pb-5 pt-1">
                <span
                  className={cn(
                    "text-body font-medium",
                    step.state === "pending" || step.state === "skipped" ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {step.title}
                </span>
                <span className="break-words text-meta text-muted-foreground">{step.body}</span>
              </div>
            </li>
          ))}
        </ol>
        {ready ? (
          <div className="flex justify-end">
            <Button size="sm" onClick={() => onOpenChange(false)}>
              Close and bind
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="mr-2 inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
    >
      {children}
      <ArrowSquareOut className="size-3" aria-hidden="true" />
    </a>
  );
}

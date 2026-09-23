"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react/ssr";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { StepState } from "@/lib/reports/case-view";
import type { TargetSuggestion } from "@/lib/targets/suggest";
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
export function ConnectGuide({ suggestion }: { suggestion: TargetSuggestion }) {
  const [open, setOpen] = useState(false);
  const upstream = suggestion.unconnected[0];
  if (!upstream) return null;

  const steps: { state: StepState; title: string; body: React.ReactNode }[] = [
    {
      state: "current",
      title: "Fork it",
      body: (
        <>
          Fork {upstream} into an account BountyDesk is installed on.{" "}
          <ExternalLink href={`https://github.com/${upstream}/fork`}>Fork on GitHub</ExternalLink>
        </>
      ),
    },
    {
      state: "pending",
      title: "Add the fork to BountyDesk",
      body: (
        <>
          Give the App access to the fork. Onboarding starts on its own once it is added.{" "}
          {suggestion.connectLinks.map((link) => (
            <ExternalLink key={link.href} href={link.href}>
              {suggestion.connectLinks.length > 1 ? `Manage ${link.account}` : "Manage repositories"}
            </ExternalLink>
          ))}
        </>
      ),
    },
    {
      state: "pending",
      title: "Approve its manifest",
      body: (
        <>
          BountyDesk builds the fork in a sandbox and proposes how to run it. A reviewer approves it on{" "}
          <Link href="/connections" className="text-foreground underline-offset-4 hover:underline">
            Connections
          </Link>
          .
        </>
      ),
    },
    {
      state: "pending",
      title: "Bind and reproduce",
      body: "The new target appears here, already selected. Bind it, then Reproduce.",
    },
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline">Connect</Button>} />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reproduce against {upstream}</DialogTitle>
          <DialogDescription>
            BountyDesk only reproduces against repositories that are connected and onboarded, so this
            report can be analysed but not reproduced yet.
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
                    step.state === "pending" ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {step.title}
                </span>
                <span className="text-meta text-muted-foreground">{step.body}</span>
              </div>
            </li>
          ))}
        </ol>
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

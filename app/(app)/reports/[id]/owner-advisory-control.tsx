"use client";

import { useState, useTransition } from "react";
import { CircleNotch } from "@phosphor-icons/react/ssr";
import { useQueryClient } from "@tanstack/react-query";

import { requestOwnerAdvisoryAction } from "@/app/review/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { refreshReportViews } from "@/lib/reports/live-keys";
import type { CaseLiveView } from "@/lib/reports/case-view";

/**
 * Notify the repository's owner of a reproduced email report, as a private draft advisory.
 *
 * Offered only once the reporter has the verdict. The dialog shows the exact text and where it
 * goes, because the click is what sends it to a second audience; the server re-checks every
 * condition shown here, and the worker re-checks the grant and the approved hash at send time.
 */
export function OwnerAdvisoryControl({
  reportId,
  status,
  repositoryFullName,
}: {
  reportId: string;
  status: CaseLiveView;
  repositoryFullName: string | null;
}) {
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const advisory = status.ownerAdvisory;
  if (advisory?.state === "SENT" && advisory.htmlUrl) {
    return (
      <a
        href={advisory.htmlUrl}
        target="_blank"
        rel="noreferrer"
        className="text-body text-foreground underline-offset-4 hover:underline"
      >
        Draft advisory opened
      </a>
    );
  }
  if (advisory && advisory.state !== "FAILED")
    return (
      <span className="flex items-center gap-2 text-body text-foreground">
        <CircleNotch
          className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
          aria-hidden="true"
        />
        Opening a draft advisory
      </span>
    );

  const offerable =
    status.channel === "email" &&
    status.state === "DELIVERED" &&
    status.verdictOutcome === "REPRODUCED" &&
    repositoryFullName !== null &&
    status.verdict !== null;
  if (!offerable)
    return <span className="text-body text-foreground">Not notified</span>;

  function notify() {
    setError(null);
    startTransition(async () => {
      const result = await requestOwnerAdvisoryAction(reportId);
      if (!result.ok) {
        setError(result.error ?? "Could not ask for the owner to be notified.");
        return;
      }
      setOpen(false);
      refreshReportViews(queryClient, reportId);
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {/* A failed send can be asked for again once whatever GitHub refused is fixed. */}
      {advisory?.state === "FAILED" ? (
        <span className="whitespace-normal break-words text-meta text-destructive">
          {advisory.lastError ?? "Could not open the advisory."}
        </span>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger
          render={
            <Button size="sm" variant="outline">
              {advisory?.state === "FAILED"
                ? "Try again"
                : "Notify owner on GitHub"}
            </Button>
          }
        />
        <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Open a private advisory on {repositoryFullName}?
            </DialogTitle>
            <DialogDescription>
              A draft security advisory, visible only to the repository&apos;s
              admins and security managers. It carries the verdict the reporter
              received, exactly as below, and nothing that identifies the
              reporter.
            </DialogDescription>
          </DialogHeader>
          {/* Text, never markup: the payload is agent-drafted and may echo content off a target. */}
          <pre className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/50 p-3 text-meta">
            {status.verdict?.payload}
          </pre>
          {error ? (
            <span className="whitespace-normal break-words text-meta text-destructive">
              {error}
            </span>
          ) : null}
          <DialogFooter>
            <Button
              size="sm"
              onClick={notify}
              loading={pending}
              disabled={pending}
            >
              Open draft advisory
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

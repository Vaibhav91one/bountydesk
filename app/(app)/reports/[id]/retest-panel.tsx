"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { requestRetestAction } from "@/app/review/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type PanelRetest = {
  id: string;
  childReportId: string;
  commitSha: string;
  actor: string;
  createdAt: string;
  /** Null while the retest is still running. */
  result: string | null;
};

const RESULT_TEXT: Record<string, string> = {
  FIXED: "Fixed: the issue no longer reproduces",
  NOT_FIXED: "Not fixed: the issue still reproduces",
  PARTIALLY_FIXED: "Partially fixed",
  INCONCLUSIVE: "Inconclusive",
};

/**
 * Fix-verification for a REPRODUCED report. The reviewer supplies the commit that carries the fix;
 * the retest runs as a separate report and its result is evidence for a human, never sent to the
 * reporter and never a change to this report's verdict.
 */
export function RetestPanel({
  reportId,
  retests,
  canStart,
}: {
  reportId: string;
  retests: PanelRetest[];
  /** False when the report cannot be retested; the list still shows past retests. */
  canStart: boolean;
}) {
  const router = useRouter();
  const [commit, setCommit] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);
    try {
      const result = await requestRetestAction(reportId, commit);
      if (!result.ok) setError(result.error ?? "Could not start the retest.");
      else {
        setCommit("");
        router.refresh();
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 border-b border-border/50 px-8 py-5">
      <h2 className="text-heading text-foreground">Retest after a fix</h2>
      {canStart ? (
        <>
          <p className="text-meta text-muted-foreground">
            Enter the full commit SHA that carries the fix. The agent rebuilds that commit of the
            connected repository and checks whether the reported issue still reproduces. Public
            repositories only. The result is for you; nothing is sent to the reporter.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={commit}
              onChange={(event) => setCommit(event.target.value)}
              placeholder="40-character commit SHA"
              className="max-w-md font-mono"
              disabled={pending}
            />
            <Button size="sm" onClick={start} loading={pending} disabled={pending || commit.trim().length === 0}>
              Start retest
            </Button>
          </div>
          {error ? <span className="whitespace-normal break-words text-meta text-destructive">{error}</span> : null}
        </>
      ) : null}
      {retests.length === 0 ? (
        <p className="text-meta text-muted-foreground">No retests yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {retests.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
              <span className="font-mono text-foreground">{item.commitSha.slice(0, 12)}</span>
              <span>{item.result ? (RESULT_TEXT[item.result] ?? item.result) : "Running"}</span>
              <span>by {item.actor}</span>
              <Link
                href={`/reports/${item.childReportId}`}
                className="text-foreground underline-offset-4 hover:text-brand-soft hover:underline"
              >
                Open the retest
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

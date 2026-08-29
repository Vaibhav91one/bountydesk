"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowSquareOut,
  CaretRight,
  Check,
  Signature,
  Warning,
} from "@phosphor-icons/react/ssr";
import { GitHubLight } from "developer-icons";

import { PhaseDot } from "@/components/phase-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import { LoaderGrid, ShimmerLabel } from "./[id]/agent-trace";
import { reportSheet, type ReportSheetData } from "./actions";

const STATE_LABEL: Record<string, string> = {
  TRIAGING: "Triaging",
  REPRODUCING: "Reproducing",
  ANALYSIS_ONLY: "Analysis only",
  AWAITING_APPROVAL: "Awaiting approval",
  DELIVERING: "Delivering",
  DELIVERED: "Delivered",
  DENIED: "Denied",
  OUT_OF_SCOPE: "Out of scope",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};

const OUTCOME: Record<string, string> = {
  REPRODUCED: "Reproduced",
  NOT_REPRODUCED: "Not reproduced",
  INCONCLUSIVE: "Inconclusive",
  ANALYSIS_ONLY: "Analysis only",
};

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border/50 bg-background p-3">
      <span className="font-mono text-meta text-muted-foreground">{label}</span>
      <span className="text-heading text-foreground">{children}</span>
    </div>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-body font-medium text-foreground">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * One report, without leaving the list.
 *
 * A summary, not a second case file. Everything that changes a report lives behind the
 * approval gate on the full page, and the sheet's job is to answer "is this the one I want"
 * fast enough that opening the wrong report costs nothing.
 *
 * The panel reads on open. A closed sheet fetches nothing, so scrolling a two-hundred row
 * index does not carry two hundred reports' events with it.
 */
export function ReportSheet({
  id,
  phase,
  onOpenChange,
}: {
  /** The report to show, or null for a closed sheet. */
  id: string | null;
  phase: string;
  onOpenChange: (open: boolean) => void;
}) {
  // One piece of state carrying which report it is for, rather than three that have to be
  // cleared together. Clearing them at the top of the effect is a synchronous setState during
  // an effect, which is both an extra render and the thing the hooks lint is right to object
  // to; comparing the id here answers "is this still loading" without one.
  const [result, setResult] = useState<{
    id: string;
    data: ReportSheetData | null;
    failed: boolean;
  } | null>(null);

  useEffect(() => {
    if (!id) return;
    let live = true;

    reportSheet(id)
      .then((data) => {
        if (live) setResult({ id, data, failed: false });
      })
      .catch(() => {
        if (live) setResult({ id, data: null, failed: true });
      });

    return () => {
      live = false;
    };
  }, [id]);

  const settled = result?.id === id ? result : null;
  const data = settled?.data ?? null;
  const failed = settled?.failed ?? false;
  const missing = settled !== null && !settled.failed && settled.data === null;

  return (
    <Sheet open={id !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="no-scrollbar gap-0 overflow-y-auto sm:max-w-lg"
      >
        {failed ? (
          <div className="p-6">
            <p
              role="alert"
              className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-body text-destructive"
            >
              <Warning className="mt-0.5 size-4 shrink-0" />
              This report could not be read. Nothing was changed.
            </p>
          </div>
        ) : missing ? (
          <div className="p-6">
            <p className="text-body text-muted-foreground">
              This report no longer exists. The list you opened it from is out of date; reload
              to see what is actually there.
            </p>
          </div>
        ) : !data ? (
          <div className="flex items-center gap-2.5 p-6">
            <LoaderGrid />
            <ShimmerLabel>Reading the report</ShimmerLabel>
          </div>
        ) : (
          <>
            <SheetHeader className="gap-3 border-b border-border/50 p-6">
              <SheetTitle className="flex items-start gap-2 text-title">
                <span className="min-w-0 flex-1">{data.title}</span>
                <Link
                  href={`/reports/${data.id}`}
                  aria-label="Open the full case file"
                  className="mt-1 shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <ArrowSquareOut className="size-4" />
                </Link>
              </SheetTitle>

              <SheetDescription className="flex flex-col gap-1.5">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
                  <GitHubLight className="size-3.5" />
                  {data.issueUrl ? (
                    <a
                      href={data.issueUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-brand-soft underline-offset-4 hover:underline"
                    >
                      {data.sourceLabel}
                    </a>
                  ) : (
                    <span>{data.sourceLabel}</span>
                  )}
                  {data.repositoryFullName ? <span>· {data.repositoryFullName}</span> : null}
                  {data.reporterHandle ? <span>· {data.reporterHandle}</span> : null}
                </span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
                  <PhaseDot phase={phase} />
                  {STATE_LABEL[data.state] ?? data.state}
                  <span>· changed {data.updatedAt}</span>
                </span>
              </SheetDescription>
            </SheetHeader>

            <div className="flex flex-col gap-4 p-6">
              {data.awaiting ? (
                <Link
                  href={`/reports/${data.id}`}
                  className="flex items-center justify-between gap-3 rounded-xl bg-phase-approval/15 px-4 py-3.5"
                >
                  <span className="flex items-center gap-2.5 text-body text-phase-approval">
                    <Signature weight="fill" className="size-4" />
                    A reviewer has to sign this one
                  </span>
                  <CaretRight aria-hidden="true" className="size-4 text-phase-approval" />
                </Link>
              ) : null}

              <Section
                title="Run"
                aside={
                  <Badge variant="outline">
                    {data.target ? "Target bound" : "No target bound"}
                  </Badge>
                }
              >
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Recorded events">{data.eventCount}</Stat>
                  <Stat label="Verdict revision">{data.verdict?.revision ?? "None"}</Stat>
                </div>

                {/* Only what the record holds. No canary, no duration, no resource use: no
                    sandbox has run, so there is nothing to report about one. */}
                <dl className="flex flex-col">
                  <Row label="Bound target">{data.target ?? "None"}</Row>
                  {data.targetDigest ? (
                    <Row label="Image digest">
                      <span className="font-mono text-meta break-all">{data.targetDigest}</span>
                    </Row>
                  ) : null}
                  <Row label="Arrived">{data.createdAt}</Row>
                </dl>

                {data.events.length > 0 ? (
                  <ul className="flex flex-col gap-1.5 border-t border-border/50 pt-3">
                    {data.events.map((event) => (
                      <li key={event.seq} className="flex items-center gap-2">
                        <Check
                          weight="bold"
                          aria-hidden="true"
                          className="size-3 shrink-0 text-phase-delivered"
                        />
                        <span className="min-w-0 flex-1 truncate text-meta text-foreground">
                          {event.type}
                        </span>
                        <span className="shrink-0 font-mono text-meta tabular-nums text-muted-foreground">
                          {event.at}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Section>

              <Section
                title="Verdict"
                aside={
                  data.verdict ? (
                    <Badge variant="outline">
                      {OUTCOME[data.verdict.outcome] ?? data.verdict.outcome}
                    </Badge>
                  ) : (
                    <Badge variant="outline">None drafted</Badge>
                  )
                }
              >
                {data.verdict ? (
                  <>
                    <p className="text-body text-muted-foreground">{data.verdict.summary}</p>
                    <dl className="flex flex-col">
                      <Row label="Content hash">
                        <span className="font-mono text-meta break-all">
                          {data.verdict.contentHash}
                        </span>
                      </Row>
                      {data.approval ? (
                        <Row label="Decision">
                          <span
                            className={cn(
                              data.approval.decision === "APPROVED"
                                ? "text-phase-delivered"
                                : "text-destructive",
                            )}
                          >
                            {data.approval.decision === "APPROVED" ? "Approved" : "Denied"}
                          </span>{" "}
                          by {data.approval.reviewer} on {data.approval.at}
                        </Row>
                      ) : null}
                      {data.approval?.note ? <Row label="Note">{data.approval.note}</Row> : null}
                    </dl>
                  </>
                ) : (
                  <p className="text-body text-muted-foreground">
                    Nothing has been drafted, so there is nothing to approve.
                  </p>
                )}
              </Section>

              {data.delivery ? (
                <Section
                  title="Delivery"
                  aside={<Badge variant="outline">{data.delivery.state.toLowerCase()}</Badge>}
                >
                  <dl className="flex flex-col">
                    <Row label="Attempts">{data.delivery.attempts}</Row>
                    {data.delivery.lastError ? (
                      <Row label="Last error">{data.delivery.lastError}</Row>
                    ) : null}
                  </dl>
                </Section>
              ) : null}

              <Button
                nativeButton={false}
                render={<Link href={`/reports/${data.id}`} />}
                className="w-full justify-center"
              >
                Open the case file <CaretRight className="size-3.5" />
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/50 py-2 last:border-b-0">
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-meta text-foreground">{children}</dd>
    </div>
  );
}

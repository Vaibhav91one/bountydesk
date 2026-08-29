"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { MagnifyingGlass, Signature } from "@phosphor-icons/react/ssr";

import { PhaseDot } from "@/components/phase-dot";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatStamp } from "@/lib/format";
import type { IndexRow } from "@/lib/reports/queue";
import { cn } from "@/lib/utils";

/**
 * Dates cross the server boundary as strings, and the phase comes with them.
 *
 * phaseOf lives in lib/reports/queue, which imports lib/db and builds a connection pool at
 * module load. Importing one pure function from it would pull the whole pg driver into the
 * browser bundle, so the server does the lookup and sends the answer.
 */
type Row = Omit<IndexRow, "updatedAt" | "createdAt"> & {
  updatedAt: string;
  createdAt: string;
  phase: string;
};

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

/**
 * The filters, as the two questions a reviewer actually arrives with.
 *
 * Open and Closed rather than one chip per state: ten chips is a legend, not a filter, and the
 * state is already on every row. Waiting is separate because it is the only one that is a
 * queue of work rather than a description of where something got to.
 */
const FILTERS = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "waiting", label: "Waiting on me" },
  { key: "closed", label: "Closed" },
] as const;

const TERMINAL = ["DELIVERED", "DENIED", "OUT_OF_SCOPE", "CANCELLED", "EXPIRED"];

export function ReportsTable({ rows }: { rows: Row[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");

  const counts = useMemo(
    () => ({
      all: rows.length,
      open: rows.filter((row) => !TERMINAL.includes(row.state)).length,
      waiting: rows.filter((row) => row.awaitingVerdictId).length,
      closed: rows.filter((row) => TERMINAL.includes(row.state)).length,
    }),
    [rows],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter === "open" && TERMINAL.includes(row.state)) return false;
      if (filter === "closed" && !TERMINAL.includes(row.state)) return false;
      if (filter === "waiting" && !row.awaitingVerdictId) return false;
      if (!needle) return true;

      // Title, issue number and origin, because those are the three things somebody arrives
      // holding. Not the state: that is what the filter above is for.
      return (
        row.title.toLowerCase().includes(needle) ||
        row.sourceLabel.toLowerCase().includes(needle) ||
        row.origin.toLowerCase().includes(needle)
      );
    });
  }, [rows, query, filter]);

  if (rows.length === 0) {
    return (
      <div className="p-8">
        <div className="flex flex-col items-start gap-3 rounded-xl border border-border/50 bg-card p-8">
          <h2 className="text-heading text-foreground">No reports yet</h2>
          <p className="max-w-2xl text-body text-muted-foreground">
            Nothing has arrived. A report enters through a connected repository&rsquo;s issues,
            and the other two channels, email and upload, are designed and not built.
          </p>
          <Link
            href="/integrations"
            className="text-body text-brand-soft underline underline-offset-4"
          >
            Open integrations
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-8">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-64 flex-1">
          <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by title, issue or repository"
            aria-label="Search reports"
            className="h-11 border-border/50 pl-9 text-body"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {FILTERS.map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={filter === option.key}
              onClick={() => setFilter(option.key)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-body transition-colors duration-150",
                filter === option.key
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/40",
              )}
            >
              {option.label}
              <span className="text-meta text-muted-foreground">{counts[option.key]}</span>
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-xl border border-border/50 bg-card p-8 text-body text-muted-foreground">
          Nothing matches. {rows.length} {rows.length === 1 ? "report" : "reports"} in total.
        </p>
      ) : (
        <ul className="flex flex-col overflow-hidden rounded-xl border border-border/50 bg-card">
          {visible.map((row) => (
            <li key={row.id} className="border-b border-border/50 last:border-b-0">
              <Link
                href={`/reports/${row.id}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 hover:bg-muted/40"
              >
                <PhaseDot phase={row.phase} />

                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-body font-medium text-foreground">
                    {row.title}
                  </span>
                  <span className="truncate text-meta text-muted-foreground">
                    {row.sourceLabel} · {row.origin} ·{" "}
                    {row.targetName ?? "no target bound"} · {row.eventCount}{" "}
                    {row.eventCount === 1 ? "event" : "events"}
                  </span>
                </span>

                {/* Only where a reviewer can actually do something. A badge on every awaiting
                    row would include the ones with no pending call behind them. */}
                {row.awaitingVerdictId ? (
                  <Badge variant="outline" className="text-phase-approval">
                    <Signature weight="fill" /> Needs you
                  </Badge>
                ) : null}

                {row.outcome ? (
                  <span className="shrink-0 text-meta text-muted-foreground">
                    {OUTCOME[row.outcome] ?? row.outcome}
                  </span>
                ) : null}

                <span className="w-36 shrink-0 text-meta text-muted-foreground">
                  {STATE_LABEL[row.state] ?? row.state}
                </span>

                <span className="shrink-0 text-meta text-muted-foreground">
                  {formatStamp(new Date(row.updatedAt))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

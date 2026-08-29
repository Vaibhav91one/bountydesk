"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { MagnifyingGlass, Signature } from "@phosphor-icons/react/ssr";

import { FilterTable, type TableRow as Row } from "@/components/filter-table";
import { PhaseDot } from "@/components/phase-dot";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatStamp } from "@/lib/format";
import type { IndexRow } from "@/lib/reports/queue";

import { ReportSheet } from "./report-sheet";

/**
 * Dates cross the server boundary as strings, and the phase comes with them.
 *
 * phaseOf lives in lib/reports/queue, which imports lib/db and builds a connection pool at
 * module load. Importing one pure function from it would pull the whole pg driver into the
 * browser bundle, so the server does the lookup and sends the answer.
 */
type ReportRow = Omit<IndexRow, "updatedAt" | "createdAt"> & {
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

const COLUMNS = [
  { key: "report", label: "Report", width: "1.6fr" },
  { key: "origin", label: "Source", width: "1fr" },
  { key: "state", label: "Status", width: "1fr" },
  { key: "updated", label: "Last change", width: "0.9fr", align: "end" as const },
];

/**
 * The filters, as the two questions a reviewer actually arrives with.
 *
 * Open and Closed rather than one chip per state: ten chips is a legend, not a filter, and the
 * state is on every row anyway. Waiting is separate because it is the only one that is a queue
 * of work rather than a description of where something got to.
 */
const FILTERS = [
  { key: "all", label: "All", dot: undefined },
  { key: "open", label: "Open", dot: "bg-phase-triaging" },
  { key: "waiting", label: "Waiting on me", dot: "bg-phase-approval" },
  { key: "closed", label: "Closed", dot: "bg-phase-closed" },
] as const;

const TERMINAL = ["DELIVERED", "DENIED", "OUT_OF_SCOPE", "CANCELLED", "EXPIRED"];

function matchesFilter(row: ReportRow, key: string): boolean {
  if (key === "open") return !TERMINAL.includes(row.state);
  if (key === "closed") return TERMINAL.includes(row.state);
  if (key === "waiting") return row.awaitingVerdictId !== null;
  return true;
}

export function ReportsTable({ rows }: { rows: ReportRow[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [open, setOpen] = useState<string | null>(null);

  const counts = useMemo(
    () =>
      Object.fromEntries(
        FILTERS.map((option) => [
          option.key,
          rows.filter((row) => matchesFilter(row, option.key)).length,
        ]),
      ),
    [rows],
  );

  const tableRows: Row[] = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.map((row) => ({
      id: row.id,
      hidden:
        !matchesFilter(row, filter) ||
        // Title, issue number and origin, because those are the three things somebody arrives
        // holding. Not the state: that is what the chips above are for.
        (needle.length > 0 &&
          !(
            row.title.toLowerCase().includes(needle) ||
            row.sourceLabel.toLowerCase().includes(needle) ||
            row.origin.toLowerCase().includes(needle)
          )),
      onSelect: () => setOpen(row.id),
      cells: [
        <span key="report" className="flex min-w-0 items-center gap-2.5">
          <PhaseDot phase={row.phase} />
          <span className="truncate font-medium text-foreground">{row.title}</span>
          {/* Only where a reviewer can actually do something. A badge on every awaiting row
              would include the ones with no pending call behind them. */}
          {row.awaitingVerdictId ? (
            <Badge variant="outline" className="shrink-0 text-phase-approval">
              <Signature weight="fill" /> You
            </Badge>
          ) : null}
        </span>,
        <span key="origin" className="min-w-0 truncate text-muted-foreground">
          {row.sourceLabel} · {row.origin}
        </span>,
        <span key="state" className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <span className="truncate">{STATE_LABEL[row.state] ?? row.state}</span>
          {row.outcome ? (
            <span className="shrink-0 text-meta">{OUTCOME[row.outcome] ?? row.outcome}</span>
          ) : null}
        </span>,
        <span key="updated" className="truncate text-meta text-muted-foreground">
          {formatStamp(new Date(row.updatedAt))}
        </span>,
      ],
    }));
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

  const phase = rows.find((row) => row.id === open)?.phase ?? "triaging";

  return (
    <div className="flex flex-col gap-4 p-8">
      <div className="relative">
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

      <FilterTable
        columns={COLUMNS}
        filters={FILTERS.map((option) => ({
          key: option.key,
          label: option.label,
          dot: option.dot,
          count: counts[option.key] ?? 0,
        }))}
        active={filter}
        onFilter={setFilter}
        rows={tableRows}
        label="Reports"
        empty={
          <>
            Nothing matches. {rows.length} {rows.length === 1 ? "report" : "reports"} in total.
          </>
        }
      />

      <ReportSheet id={open} phase={phase} onOpenChange={(next) => !next && setOpen(null)} />
    </div>
  );
}

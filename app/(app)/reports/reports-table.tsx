"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { GithubLogo, MagnifyingGlass, Signature, X } from "@phosphor-icons/react/ssr";

import { FilterTable, type TableRow as Row } from "@/components/filter-table";
import { PhaseDot } from "@/components/phase-dot";
import {
  ReportOutcomeBadge,
  ReportStateBadge,
  shouldShowOutcomeBadge,
} from "@/components/report-badges";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatStamp } from "@/lib/format";
import type { IndexRow } from "@/lib/reports/queue";


/**
 * Dates cross the server boundary as strings, and the phase comes with them.
 *
 * phaseOf lives in lib/reports/queue, which imports lib/db and builds a connection pool at
 * module load. Importing one pure function from it would pull the whole pg driver into the
 * browser bundle, so the server does the lookup and sends the answer.
 */
export type ReportRow = Omit<IndexRow, "updatedAt" | "createdAt"> & {
  updatedAt: string;
  createdAt: string;
  phase: string;
};


const COLUMNS = [
  { key: "report", label: "Report", width: "1.6fr" },
  { key: "origin", label: "Source", width: "0.9fr" },
  { key: "state", label: "Status", width: "1.4fr" },
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

/**
 * Renders whatever rows it is handed and nothing else.
 *
 * Deliberately free of data fetching: the landing page draws this same table over fixtures,
 * outside the signed-in shell, where there is no QueryClient to read from and no session to
 * poll with. reports-live.tsx is the console's wrapper that keeps the rows current.
 */
export function ReportsTable({ rows }: { rows: ReportRow[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string>("all");
  // Repos pinned as filter pills, GitHub-issue style: a report is kept only if its repo is selected.
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [searchFocused, setSearchFocused] = useState(false);
  // Which suggestion the arrow keys have moved to, so Enter can pick it. onMouseDown gives mouse
  // users a path but fires before the input's blur; keyboard users get here instead.
  const [activeSuggestion, setActiveSuggestion] = useState(0);

  // The repos that actually have reports, for the suggestion list. Deriving from the rows in hand
  // means the suggestions are exactly the repos worth scoping to, with no extra fetch.
  const allRepos = useMemo(
    () => [...new Set(rows.map((row) => row.origin).filter((origin) => origin.includes("/")))].sort(),
    [rows],
  );
  const repoSuggestions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allRepos
      .filter((repo) => !selectedRepos.includes(repo) && repo.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [allRepos, selectedRepos, query]);

  const addRepo = (repo: string) => {
    setSelectedRepos((current) => (current.includes(repo) ? current : [...current, repo]));
    setQuery("");
    setActiveSuggestion(0);
  };
  const removeRepo = (repo: string) => setSelectedRepos((current) => current.filter((r) => r !== repo));

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
        (selectedRepos.length > 0 && !selectedRepos.includes(row.origin)) ||
        // Title, issue number and origin, because those are the three things somebody arrives
        // holding. Not the state: that is what the chips above are for.
        (needle.length > 0 &&
          !(
            row.title.toLowerCase().includes(needle) ||
            row.sourceLabel.toLowerCase().includes(needle) ||
            row.origin.toLowerCase().includes(needle)
          )),
      // Straight to the case file. A summary in a panel was a stop on the way to the
      // page that has everything, and the row already says what the summary said.
      onSelect: () => router.push(`/reports/${row.id}`),
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
        <span key="state" className="flex min-w-0 items-center gap-2">
          <ReportStateBadge
            state={row.state}
            phase={row.phase}
            deliveryState={row.deliveryState}
            failed={row.handoffFailed}
          />
          {shouldShowOutcomeBadge(row.state, row.outcome) ? (
            <ReportOutcomeBadge outcome={row.outcome} />
          ) : null}
        </span>,
        <span key="updated" className="truncate text-meta text-muted-foreground">
          {formatStamp(new Date(row.updatedAt))}
        </span>,
      ],
    }));
  }, [rows, query, filter, router, selectedRepos]);

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
      <div className="flex flex-col gap-2">
        {selectedRepos.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {selectedRepos.map((repo) => (
              <Badge key={repo} variant="outline" className="gap-1 pr-1">
                <GithubLogo weight="fill" className="size-3.5" />
                <span className="max-w-[16rem] truncate">{repo}</span>
                <button
                  type="button"
                  onClick={() => removeRepo(repo)}
                  aria-label={`Remove ${repo} filter`}
                  className="ml-0.5 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <div className="relative">
          <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveSuggestion(0);
            }}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            onKeyDown={(event) => {
              if (repoSuggestions.length === 0) return;
              const active = Math.min(activeSuggestion, repoSuggestions.length - 1);
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveSuggestion(Math.min(active + 1, repoSuggestions.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveSuggestion(Math.max(active - 1, 0));
              } else if (event.key === "Enter") {
                // Pick the highlighted repo rather than submitting the surrounding form.
                event.preventDefault();
                addRepo(repoSuggestions[active]);
              }
            }}
            placeholder="Filter by repository, or search title & issue"
            aria-label="Search reports"
            role="combobox"
            aria-expanded={searchFocused && repoSuggestions.length > 0}
            aria-controls="repo-suggestions"
            className="h-11 border-border/50 pl-9 text-body"
          />
          {searchFocused && repoSuggestions.length > 0 && (
            <ul
              id="repo-suggestions"
              role="listbox"
              className="absolute top-full z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-md"
            >
              {repoSuggestions.map((repo, i) => {
                const active = i === Math.min(activeSuggestion, repoSuggestions.length - 1);
                return (
                  <li key={repo} role="option" aria-selected={active}>
                    <button
                      type="button"
                      // mouseDown, not click: fire before the input's blur hides this list.
                      onMouseDown={(event) => {
                        event.preventDefault();
                        addRepo(repo);
                      }}
                      onMouseEnter={() => setActiveSuggestion(i)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${active ? "bg-muted" : ""}`}
                    >
                      <GithubLogo weight="fill" className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{repo}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
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

    </div>
  );
}

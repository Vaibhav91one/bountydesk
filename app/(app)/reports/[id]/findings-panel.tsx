import { Warning } from "@phosphor-icons/react/ssr";

import { FilterTable, type TableRow } from "@/components/filter-table";
import { Badge } from "@/components/ui/badge";
import type { Finding } from "@/lib/mcp/publish-verdict";

/**
 * What the agent's own investigation found, as a table on the same primitive the reports list
 * uses (components/filter-table.tsx).
 *
 * Each row is the agent's claim, not a certified fact: the evidence column points at what backs
 * it (an artifact path, a scope-guard audit-log entry, an OSV id), so a reviewer can go check
 * rather than take the description on faith. An empty list means the run drafted a verdict with
 * nothing beyond its summary, which the summary itself already says.
 */

const SEVERITY_VARIANT: Record<Finding["severity"], "destructive" | "default" | "secondary" | "outline"> = {
  critical: "destructive",
  high: "destructive",
  medium: "default",
  low: "secondary",
  info: "outline",
};

const COLUMNS = [
  { key: "title", label: "Finding", width: "1.5fr" },
  { key: "severity", label: "Severity", width: "0.6fr" },
  { key: "evidence", label: "Evidence", width: "1fr" },
];

export function FindingsPanel({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) {
    return (
      <p className="flex items-start gap-2.5 text-body text-muted-foreground">
        <Warning aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        No findings beyond the verdict&apos;s own summary were drafted for this run.
      </p>
    );
  }

  const rows: TableRow[] = findings.map((finding, index) => ({
    id: `${finding.title}-${index}`,
    cells: [
      <span key="title" className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-medium text-foreground">{finding.title}</span>
        {/* The description rides under the title rather than in its own column: it is the long
            field, and a column wide enough for it would starve the other two. */}
        <span className="text-meta text-muted-foreground">{finding.description}</span>
      </span>,
      <Badge key="severity" variant={SEVERITY_VARIANT[finding.severity]}>
        {finding.severity}
      </Badge>,
      <span key="evidence" className="min-w-0 font-mono text-meta break-all text-muted-foreground">
        {finding.evidenceRef}
      </span>,
    ],
  }));

  return (
    <FilterTable
      columns={COLUMNS}
      rows={rows}
      label="Findings"
      empty="No findings drafted."
    />
  );
}

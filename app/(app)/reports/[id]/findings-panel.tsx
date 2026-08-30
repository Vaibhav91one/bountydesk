"use client";

import { useState } from "react";
import { Warning } from "@phosphor-icons/react/ssr";

import { FilterTable, type TableRow } from "@/components/filter-table";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Finding } from "@/lib/mcp/publish-verdict";

/**
 * What the agent's own investigation found, as a table on the same primitive the reports list
 * uses (components/filter-table.tsx).
 *
 * Each row is the agent's claim, not a certified fact: the evidence column points at what backs
 * it (an artifact path, a scope-guard audit-log entry, an OSV id), so a reviewer can go check
 * rather than take the description on faith. The row clamps the long fields to two lines so a
 * verbose finding cannot blow out the table; the untruncated text lives in the sheet a row
 * opens. An empty list means the run drafted a verdict with nothing beyond its summary, which
 * the summary itself already says.
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
  // The row a reviewer opened, or none. base-ui's Dialog gives the sheet its focus trap,
  // Escape-to-close and aria wiring, so this component only decides which finding it shows.
  const [selected, setSelected] = useState<Finding | null>(null);

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
    onSelect: () => setSelected(finding),
    cells: [
      <span key="title" className="flex min-w-0 flex-col gap-1">
        <span className="line-clamp-2 font-medium text-foreground">{finding.title}</span>
        {/* The description rides under the title rather than in its own column: it is the long
            field, and a column wide enough for it would starve the other two. Clamped here,
            full in the sheet. */}
        <span className="line-clamp-2 text-meta text-muted-foreground">{finding.description}</span>
      </span>,
      <Badge key="severity" variant={SEVERITY_VARIANT[finding.severity]}>
        {finding.severity}
      </Badge>,
      <span key="evidence" className="line-clamp-2 min-w-0 font-mono text-meta break-all text-muted-foreground">
        {finding.evidenceRef}
      </span>,
    ],
  }));

  return (
    <>
      <FilterTable columns={COLUMNS} rows={rows} label="Findings" empty="No findings drafted." />

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent side="right" className="no-scrollbar gap-0 overflow-y-auto sm:max-w-md">
          {selected ? (
            <>
              <SheetHeader className="gap-3 border-b border-border/50 p-6">
                <SheetTitle className="text-title break-words">{selected.title}</SheetTitle>
                <SheetDescription>
                  <Badge variant={SEVERITY_VARIANT[selected.severity]}>{selected.severity}</Badge>
                </SheetDescription>
              </SheetHeader>

              <div className="flex flex-col gap-5 p-6">
                <section className="flex flex-col gap-2">
                  <h3 className="text-meta text-muted-foreground">Description</h3>
                  {/* The full text, shown not interpreted: the agent may have read
                      prompt-injection content off an untrusted target, so its prose is
                      rendered verbatim. whitespace-pre-wrap keeps the breaks it wrote. */}
                  <p className="whitespace-pre-wrap break-words text-body text-foreground">
                    {selected.description}
                  </p>
                </section>

                <section className="flex flex-col gap-2">
                  <h3 className="text-meta text-muted-foreground">Evidence</h3>
                  <p className="font-mono text-meta break-all text-muted-foreground">
                    {selected.evidenceRef}
                  </p>
                </section>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}

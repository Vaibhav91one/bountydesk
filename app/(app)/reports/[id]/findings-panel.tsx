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

import { ArtifactDownload } from "./artifact-download";
import { FindingDescription } from "./finding-description";

/**
 * What the agent's own investigation found, as a table on the same primitive the reports list
 * uses (components/filter-table.tsx).
 *
 * Each row is the agent's claim, not a certified fact. What backs it is the findings file the run
 * recorded, which a reviewer can download and read; the reference the agent cited names a path
 * inside the harness sandbox, and printing that on screen offered a check nobody could perform.
 *
 * The row clamps the long fields to two lines so a verbose finding cannot blow out the table. The
 * untruncated text lives in the sheet a row opens, laid out as the agent wrote it: reproduction
 * steps as steps. An empty list means the run drafted a verdict with nothing beyond its summary,
 * which the summary itself already says.
 */

const SEVERITY_VARIANT: Record<Finding["severity"], "destructive" | "default" | "secondary" | "outline"> = {
  critical: "destructive",
  high: "destructive",
  medium: "default",
  low: "secondary",
  info: "outline",
};

const COLUMNS = [
  { key: "title", label: "Finding", width: "2fr" },
  // One badge, centred under its own heading: left-aligned it drifted away from a header that
  // sits over a much wider track than the badge needs.
  { key: "severity", label: "Severity", width: "0.7fr", align: "center" as const },
];

export function FindingsPanel({
  findings,
  findingsArtifactId,
}: {
  findings: Finding[];
  /** The recorded findings file, when one was stored. */
  findingsArtifactId?: string | null;
}) {
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
    ],
  }));

  return (
    <>
      <FilterTable columns={COLUMNS} rows={rows} label="Findings" empty="No findings drafted." />

      {findingsArtifactId ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-meta text-muted-foreground">
            Every finding above, with the evidence each one cites.
          </span>
          <ArtifactDownload artifactId={findingsArtifactId} label="Download findings" />
        </div>
      ) : null}

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        {/* Wider than the repository panel next door: a finding carries reproduction steps, and
            a request line with a payload in it wrapped four times at that width. */}
        <SheetContent side="right" className="no-scrollbar gap-0 overflow-y-auto sm:max-w-2xl">
          {selected ? (
            <>
              <SheetHeader className="gap-3 border-b border-border/50 p-6">
                <SheetTitle className="text-title break-words">{selected.title}</SheetTitle>
                <SheetDescription>
                  <Badge variant={SEVERITY_VARIANT[selected.severity]}>{selected.severity}</Badge>
                </SheetDescription>
              </SheetHeader>

              <div className="flex flex-col gap-6 p-6">
                {/* The full text, shown not interpreted: the agent may have read
                    prompt-injection content off an untrusted target, so its prose stays prose
                    and the layout comes only from structure already in it. */}
                <FindingDescription description={selected.description} />

                {findingsArtifactId ? (
                  <section className="flex flex-col items-start gap-2 border-t border-border/50 pt-5">
                    <h3 className="text-meta text-muted-foreground">Evidence</h3>
                    <p className="text-body text-muted-foreground">
                      The run recorded every finding and the evidence it cites as a file.
                    </p>
                    <ArtifactDownload artifactId={findingsArtifactId} label="Download findings" />
                  </section>
                ) : null}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}

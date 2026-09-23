"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
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
import {
  clampSheetWidth,
  setSheetWidth,
  sheetWidthServerSnapshot,
  sheetWidthSnapshot,
  storeSheetWidth,
  subscribeSheetWidth,
} from "@/lib/findings/sheet-width";
import type { Finding } from "@/lib/mcp/publish-verdict";

import { FindingDescription } from "./finding-description";

/**
 * What the agent's own investigation found, as a table on the same primitive the reports list
 * uses (components/filter-table.tsx).
 *
 * Each row is the agent's claim, not a certified fact. What backs it is the findings file the run
 * recorded, which a reviewer can download and read; the reference the agent cited names a path
 * inside the harness sandbox, and printing that on screen offered a check nobody could perform.
 *
 * The table keeps each finding to its title and severity so it stays scannable. The full text lives
 * in the sheet a row opens, laid out as the agent wrote it: reproduction steps as steps. An empty
 * list means the run drafted a verdict with nothing beyond its summary, which the summary itself
 * already says.
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

/**
 * The left edge of the sheet, dragged to widen it.
 *
 * Pointer capture rather than window listeners: the pointer leaves this 4px strip on the first
 * move, and without capture the drag would end there. `onCommit` fires once at the end so the
 * stored width is written on release, not on every frame.
 */
function ResizeHandle({
  onResize,
  onCommit,
}: {
  onResize: (clientX: number) => void;
  onCommit: () => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the finding panel"
      onPointerDown={(event) => {
        // Only the primary button, and never a touch scroll that happens to start here.
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        onResize(event.clientX);
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onCommit();
      }}
      className="absolute inset-y-0 left-0 z-20 hidden w-1.5 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-border sm:block"
    />
  );
}

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

  // The width belongs to localStorage and to a pointer drag, not to React, so it is read as an
  // external store. That also means the first paint already has the remembered width instead of
  // rendering the default and jumping.
  const width = useSyncExternalStore(
    subscribeSheetWidth,
    sheetWidthSnapshot,
    sheetWidthServerSnapshot,
  );

  // The sheet is pinned to the right edge, so its width is the distance from the pointer to it.
  const onResize = useCallback((clientX: number) => {
    setSheetWidth(clampSheetWidth(window.innerWidth - clientX, window.innerWidth));
  }, []);

  // Written once on release rather than on every frame of the drag.
  const onCommit = useCallback(() => storeSheetWidth(sheetWidthSnapshot()), []);

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
      <span key="title" className="flex min-w-0 flex-col gap-1 py-1">
        <span className="line-clamp-2 font-medium leading-relaxed text-foreground">{finding.title}</span>
      </span>,
      <Badge key="severity" variant={SEVERITY_VARIANT[finding.severity]}>
        {finding.severity}
      </Badge>,
    ],
  }));

  return (
    <>
      {/* border-border, not the /50 default: two findings on a dark card separated by a
          half-opacity line read as one blob, and a table of findings is exactly where the
          boundary between rows matters. */}
      <FilterTable
        columns={COLUMNS}
        rows={rows}
        label="Findings"
        empty="No findings drafted."
        rowClassName="border-border"
      />

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        {/* Wider than the repository panel next door: a finding carries reproduction steps, and
            a request line with a payload in it wrapped four times at that width. The width is
            an inline style rather than a class because the viewer can drag it; max-w-none is
            what stops the primitive's own cap from winning. */}
        <SheetContent
          side="right"
          style={{ width }}
          className="no-scrollbar gap-0 overflow-y-auto sm:max-w-none"
        >
          <ResizeHandle onResize={onResize} onCommit={onCommit} />
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

                <section className="flex flex-col items-start gap-2 border-t border-border/50 pt-5">
                  <h3 className="text-meta text-muted-foreground">Evidence</h3>
                  {findingsArtifactId ? (
                    <p className="text-body text-muted-foreground">
                      The run recorded every finding and the evidence each one cites in the findings
                      artifact.
                    </p>
                  ) : (
                    // No downloadable file, so the citation the agent gave is the only evidence
                    // there is. It names a path inside the harness sandbox.
                    <p className="font-mono text-meta break-all text-muted-foreground">
                      {selected.evidenceRef}
                    </p>
                  )}
                </section>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}

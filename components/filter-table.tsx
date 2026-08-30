"use client";

import { cn } from "@/lib/utils";

/**
 * A table with chips above it that filter the rows.
 *
 * Ported from a filter-table component that carried its own token system. What is worth
 * keeping is the grammar: chips that count what they would show, a bordered grid rather than a
 * <table>, and a row that collapses over a grid-template-rows transition instead of
 * disappearing, so filtering reads as the list rearranging rather than reloading.
 *
 * The caller decides what is visible. Text search and chip state differ per screen, and a
 * component that owned both would have to know what a row means; it renders every row and
 * collapses the ones marked hidden, which keeps the animation and keeps the logic where the
 * data is.
 */

export type TableColumn = {
  key: string;
  label: string;
  /** A CSS grid track. Numbers as fractions, so columns stay proportional at any width. */
  width: string;
  /** Right-aligned, for counts and timestamps. */
  align?: "start" | "end";
};

export type TableFilter = {
  key: string;
  label: string;
  /** A phase colour class, e.g. bg-phase-approval. Written out, never built from a template. */
  dot?: string;
  count: number;
};

export type TableRow = {
  id: string;
  hidden?: boolean;
  cells: React.ReactNode[];
  /** Opens whatever the screen shows for this row. A row without one is not interactive. */
  onSelect?: () => void;
};

export function FilterTable({
  columns,
  filters,
  active,
  onFilter,
  rows,
  empty,
  label,
  minWidth = 560,
}: {
  columns: TableColumn[];
  filters?: TableFilter[];
  active?: string;
  onFilter?: (key: string) => void;
  rows: TableRow[];
  /** Shown when every row is hidden. */
  empty: React.ReactNode;
  /** Names the scroll region. "Table" tells a screen-reader user nothing about which one. */
  label: string;
  minWidth?: number;
}) {
  // An inline style, not a grid-cols-[...] class. Tailwind reads source for literal class
  // names, so a template built from props compiles to nothing and every column collapses.
  const template = columns.map((column) => `minmax(0,${column.width})`).join(" ");
  const allHidden = rows.every((row) => row.hidden);

  return (
    <div className="flex flex-col gap-2">
      {filters && filters.length > 0 ? (
        <div className="no-scrollbar -mx-1 flex items-center gap-1 overflow-x-auto px-1 py-1">
          {filters.map((filter) => {
            const on = active === filter.key;
            return (
              <button
                key={filter.key}
                type="button"
                aria-pressed={on}
                onClick={() => onFilter?.(filter.key)}
                className={cn(
                  "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-meta transition-colors duration-200",
                  on ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/40",
                )}
              >
                {filter.dot ? (
                  <span aria-hidden="true" className={cn("size-1.5 rounded-full", filter.dot)} />
                ) : null}
                {filter.label}
                <span
                  className={cn(
                    "rounded px-1 tabular-nums",
                    on ? "bg-background text-muted-foreground" : "text-muted-foreground/70",
                  )}
                >
                  {filter.count}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* The scroller is the table, not the page: a narrow window scrolls the columns rather
          than pushing the whole document sideways. */}
      <div
        role="region"
        tabIndex={0}
        aria-label={label}
        className="no-scrollbar overflow-x-auto rounded-xl border border-border/50 bg-card"
      >
        <div style={{ minWidth }}>
          <div className="grid border-b border-border/50" style={{ gridTemplateColumns: template }}>
            {columns.map((column, index) => (
              <span
                key={column.key}
                className={cn(
                  "px-4 py-2.5 text-meta text-muted-foreground",
                  index < columns.length - 1 && "border-r border-border/50",
                  column.align === "end" && "text-right",
                )}
              >
                {column.label}
              </span>
            ))}
          </div>

          {allHidden ? (
            <div className="px-4 py-8 text-center text-body text-muted-foreground">{empty}</div>
          ) : null}

          {rows.map((row) => (
            <div
              key={row.id}
              // inert, not just collapsed. A row at 0fr is still in the document, so without
              // this its button stays focusable and a keyboard user tabs through rows the
              // filter is hiding, into a control they cannot see.
              inert={row.hidden ? true : undefined}
              aria-hidden={row.hidden ? true : undefined}
              className="grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]"
              style={{
                gridTemplateRows: row.hidden ? "0fr" : "1fr",
                opacity: row.hidden ? 0 : 1,
              }}
            >
              <div className="overflow-hidden">
                <RowBody row={row} columns={columns} template={template} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** How a cell is laid out. Two call sites need it now, so it is written once. */
function cellClass(columns: TableColumn[], index: number) {
  return cn(
    "flex min-w-0 items-center px-4 py-3 text-body",
    index < columns.length - 1 && "border-r border-border/50",
    columns[index]?.align === "end" && "justify-end",
  );
}

function RowBody({
  row,
  columns,
  template,
}: {
  row: TableRow;
  columns: TableColumn[];
  template: string;
}) {
  const cells = columns.map((column, index) => (
    <span
      key={column.key}
      // Above the first cell's stretched hit area, so a cell holding a control of its own
      // receives its clicks rather than the row swallowing them.
      className={cn(cellClass(columns, index), index > 0 && "relative z-10")}
    >
      {row.cells[index]}
    </span>
  ));

  const className = "grid border-b border-border/50 text-left last:border-b-0";

  // The row's control is one button in the first cell, stretched over the whole row by its
  // ::after, rather than a button wrapping every cell. A cell can hold a form or a button of
  // its own, and nesting those inside a button is invalid markup that browsers resolve by
  // guessing; it also meant a click on such a control fired the row's action as well as its
  // own. The later cells sit above that hit area so they still receive their own clicks.
  //
  // A row that does nothing stays a div rather than a button with nothing behind it.
  return row.onSelect ? (
    <div
      style={{ gridTemplateColumns: template }}
      className={cn(className, "relative transition-colors duration-100 hover:bg-muted/40")}
    >
      <span className={cellClass(columns, 0)}>
        <button
          type="button"
          // Named so a caller can tell a row apart from the chips and the search field above
          // it. The landing page's previews use it to swallow the click without losing either.
          data-row=""
          onClick={row.onSelect}
          className="flex min-w-0 flex-1 cursor-pointer items-center text-left after:absolute after:inset-0 after:content-['']"
        >
          {row.cells[0]}
        </button>
      </span>
      {cells.slice(1)}
    </div>
  ) : (
    <div className={className} style={{ gridTemplateColumns: template }}>
      {cells}
    </div>
  );
}

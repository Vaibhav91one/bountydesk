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
  minWidth = 560,
}: {
  columns: TableColumn[];
  filters?: TableFilter[];
  active?: string;
  onFilter?: (key: string) => void;
  rows: TableRow[];
  /** Shown when every row is hidden. */
  empty: React.ReactNode;
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
        aria-label="Table"
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
      className={cn(
        "flex min-w-0 items-center px-4 py-3 text-body",
        index < columns.length - 1 && "border-r border-border/50",
        column.align === "end" && "justify-end",
      )}
    >
      {row.cells[index]}
    </span>
  ));

  const className = "grid border-b border-border/50 text-left last:border-b-0";

  // A row that does something is a button, so it answers the keyboard and announces itself.
  // A row that does not stays a div rather than a button with nothing behind it.
  return row.onSelect ? (
    <button
      type="button"
      onClick={row.onSelect}
      style={{ gridTemplateColumns: template }}
      className={cn(
        className,
        "w-full cursor-pointer transition-colors duration-100 hover:bg-muted/40",
      )}
    >
      {cells}
    </button>
  ) : (
    <div className={className} style={{ gridTemplateColumns: template }}>
      {cells}
    </div>
  );
}

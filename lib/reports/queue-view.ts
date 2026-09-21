import type { QueueColumn } from "@/lib/reports/queue";

/**
 * The board's columns as they cross the wire.
 *
 * Identical to QueueColumn except that updatedAt is an ISO string, because JSON has no date and
 * the board polls itself now. Declared as a transform of the query type rather than retyped by
 * hand, so a column added to the read model reaches the board without anybody remembering to
 * add it here twice.
 */
export type QueueCardView = Omit<QueueColumn["cards"][number], "updatedAt"> & {
  updatedAt: string;
  /**
   * Relative age cut when the view was built, on the server. The board renders this string
   * instead of computing Date.now() during render, because the server and the browser would
   * compute different minutes and hydration would mismatch at any minute boundary.
   */
  ageLabel: string;
};

export type QueueColumnView = Omit<QueueColumn, "cards"> & { cards: QueueCardView[] };

/** Coarse on purpose. A queue is scanned, and "3h" answers the question "is this stuck". */
export function ageLabelFor(from: Date | string, now: number = Date.now()): string {
  const minutes = Math.floor((now - new Date(from).getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function queueColumnViews(columns: QueueColumn[]): QueueColumnView[] {
  return columns.map((column) => ({
    ...column,
    cards: column.cards.map((card) => ({
      ...card,
      updatedAt: card.updatedAt.toISOString(),
      ageLabel: ageLabelFor(card.updatedAt),
    })),
  }));
}

/**
 * The columns as a search term leaves them.
 *
 * Title, source and target, because those are what somebody arrives holding. The state is not
 * searched: the column a card sits in already says it, and matching on it would scatter hits
 * across columns that each mean something different.
 *
 * A column's total becomes the number of matches, which is the honest count while a search is
 * running. The board holds a capped number of cards per column, so this can only search the ones
 * already on screen, and keeping the server's total would count rows the search never saw.
 *
 * An empty or blank term returns the columns untouched, so a caller can hand its raw input
 * straight in rather than deciding for itself whether a search is running.
 */
export function searchQueue(columns: QueueColumnView[], term: string): QueueColumnView[] {
  const needle = term.trim().toLowerCase();
  if (needle.length === 0) return columns;

  return columns.map((column) => {
    const cards = column.cards.filter((card) =>
      [card.title, card.sourceLabel, card.targetName ?? ""].some((field) =>
        field.toLowerCase().includes(needle),
      ),
    );
    return { ...column, cards, total: cards.length };
  });
}

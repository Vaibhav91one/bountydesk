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
};

export type QueueColumnView = Omit<QueueColumn, "cards"> & { cards: QueueCardView[] };

export function queueColumnViews(columns: QueueColumn[]): QueueColumnView[] {
  return columns.map((column) => ({
    ...column,
    cards: column.cards.map((card) => ({ ...card, updatedAt: card.updatedAt.toISOString() })),
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

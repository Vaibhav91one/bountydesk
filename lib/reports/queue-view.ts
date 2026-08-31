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

"use client";

import { Card } from "@/components/queue-board";
import { PhaseDot } from "@/components/phase-dot";
import type { QueueCard, QueueColumn } from "@/lib/reports/queue";
import type { MascotKey } from "@/lib/mascot/catalog";

import { TravellingRow, useTravellingCard } from "./queue-demo";

/**
 * Three columns of the pipeline, with one card moving between the first two.
 *
 * The columns are drawn here rather than with the board's own Column, because that one renders
 * a fixed list and this needs a row that can open and close underneath the cards already in
 * it. Everything inside a column is the board's real Card.
 */
export function QueuePreview({
  columns,
  traveller,
  mascots,
  drift,
  linkPrefetch = true,
}: {
  columns: QueueColumn[];
  traveller: QueueCard;
  mascots: Map<string, MascotKey>;
  drift: Map<string, number>;
  linkPrefetch?: boolean;
}) {
  const { column: at, phase, still } = useTravellingCard();

  return (
    <div className="grid grid-cols-3 gap-4">
      {columns.map((column, index) => {
        // The traveller belongs to whichever of the first two columns currently holds it, and
        // wears that column's state so its phase dot and mascot match where it is.
        const holding = index === at;
        const state = index === 0 ? "TRIAGING" : "REPRODUCING";

        return (
          <section key={column.key} className="flex min-w-0 flex-col gap-3">
            <header className="flex items-center gap-2.5">
              <PhaseDot phase={column.key} />
              <h2 className="min-w-0 flex-1 truncate text-body font-medium text-foreground">
                {column.label}
              </h2>
              <span className="text-meta text-muted-foreground">
                {column.total + (holding ? 1 : 0)}
              </span>
            </header>

            {index < 2 ? (
              <TravellingRow present={holding} phase={phase} still={still}>
                <Card
                  // A distinct id per column: the row exists in both so it has something to
                  // collapse and something to open, and two elements cannot share a DOM id.
                  card={{ ...traveller, id: `${traveller.id}-${index}`, state } as QueueCard}
                  showState={false}
                  mascot={mascots.get(state)}
                  index={drift.get("moving") ?? 0}
                  linkPrefetch={linkPrefetch}
                />
              </TravellingRow>
            ) : null}

            {column.cards.map((card) => (
              <Card
                key={card.id}
                card={card}
                showState={false}
                mascot={mascots.get(card.state)}
                index={drift.get(card.id) ?? 0}
                linkPrefetch={linkPrefetch}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

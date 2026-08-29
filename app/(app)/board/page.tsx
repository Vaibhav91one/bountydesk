import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react/ssr";

import { RollingIcon } from "@/components/rolling-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireReviewer } from "@/lib/auth/dal";
import { listQueue, type QueueCard, type QueueColumn } from "@/lib/reports/queue";

export const metadata = { title: "Review queue · BountyDesk" };

/** How a verdict outcome reads to a reviewer, rather than how it reads to the database. */
const OUTCOME: Record<string, string> = {
  REPRODUCED: "Reproduced",
  NOT_REPRODUCED: "Not reproduced",
  INCONCLUSIVE: "Inconclusive",
  ANALYSIS_ONLY: "Analysis only",
};

const STATE_LABEL: Record<string, string> = {
  TRIAGING: "Triaging",
  REPRODUCING: "Reproducing",
  ANALYSIS_ONLY: "Analysis only",
  AWAITING_APPROVAL: "Awaiting approval",
  DELIVERING: "Delivering",
  DELIVERED: "Delivered",
  DENIED: "Denied",
  OUT_OF_SCOPE: "Out of scope",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};

/** Coarse on purpose. A queue is scanned, and "3h" answers the question "is this stuck". */
function age(from: Date): string {
  const minutes = Math.floor((Date.now() - from.getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function Card({ card, showState }: { card: QueueCard; showState: boolean }) {
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border/50 bg-card p-4">
      <div className="flex flex-col gap-1">
        <span className="text-body font-medium text-foreground">{card.title}</span>
        <span className="text-meta text-muted-foreground">
          {card.sourceLabel} · {card.targetName ?? "no target bound"}
        </span>
      </div>

      {showState ? (
        <Badge variant={card.state === "DELIVERED" ? "success" : "outline"}>
          {STATE_LABEL[card.state] ?? card.state}
        </Badge>
      ) : null}

      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        {/* The outcome, or the honest absence of one. Never a canary or a confidence: no
            reproduction has run, so the card has nothing to say about one. */}
        <span className="text-meta text-muted-foreground">
          {card.outcome ? OUTCOME[card.outcome] ?? card.outcome : "No verdict yet"}
        </span>
        <span className="text-meta text-muted-foreground">
          {card.eventCount} {card.eventCount === 1 ? "event" : "events"} · {age(card.updatedAt)}
        </span>
      </div>

      {/* Only a report with a pending call an approval can actually answer gets the button.
          One sitting in AWAITING_APPROVAL with nothing pending would lead to a page that
          refuses, which is worse than no button. */}
      {card.awaitingVerdictId ? (
        <Button
          size="sm"
          variant="outline"
          nativeButton={false}
          render={<Link href="/review" />}
          className="w-full justify-center"
        >
          Review evidence <RollingIcon icon={ArrowRight} className="size-3.5" />
        </Button>
      ) : null}
    </li>
  );
}

function Column({ column }: { column: QueueColumn }) {
  const hidden = column.total - column.cards.length;

  return (
    <section className="flex w-[280px] shrink-0 flex-col gap-3">
      <header className="flex items-center gap-2.5">
        <h2 className="text-body font-medium text-foreground">{column.label}</h2>
        <Badge variant="outline">{column.total}</Badge>
      </header>

      {column.cards.length === 0 ? (
        <p className="rounded-xl border border-border/50 border-dashed bg-card/40 px-4 py-6 text-center text-meta text-muted-foreground">
          Nothing here
        </p>
      ) : null}

      <ul className="flex flex-col gap-2.5">
        {column.cards.map((card) => (
          <Card key={card.id} card={card} showState={column.states.length > 1} />
        ))}
      </ul>

      {/* Never truncate silently: a column that stopped at the limit and said nothing reads
          as "that is all of them". */}
      {hidden > 0 ? (
        <p className="text-meta text-muted-foreground">
          {column.cards.length} of {column.total} shown
        </p>
      ) : null}
    </section>
  );
}

export default async function BoardPage() {
  await requireReviewer();
  const columns = await listQueue();
  const total = columns.reduce((sum, column) => sum + column.total, 0);

  return (
    <main className="flex flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border/50 px-8 py-7">
        <h1 className="text-title text-foreground">Review queue</h1>
        <Badge variant="outline">{total}</Badge>
      </header>

      {total === 0 ? (
        <div className="p-8">
          <div className="flex flex-col items-start gap-2 rounded-xl border border-border/50 bg-card p-8">
            <h2 className="text-heading text-foreground">No reports yet</h2>
            <p className="max-w-2xl text-body text-muted-foreground">
              Reports arrive from a connected GitHub repository. Once one is bound to a
              reproduction target, issues opened there land here.
            </p>
          </div>
        </div>
      ) : (
        // The strip scrolls, not the page: six columns do not fit the content area at 1440,
        // and a board that pushes the whole document sideways is worse than one that does not.
        <div className="flex-1 overflow-x-auto p-8">
          <div className="flex min-w-max gap-4">
            {columns.map((column) => (
              <Column key={column.key} column={column} />
            ))}
          </div>
        </div>
      )}
    </main>
  );
}

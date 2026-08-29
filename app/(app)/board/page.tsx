import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react/ssr";

import { PhaseDot, PhaseSpinner } from "@/components/phase-dot";
import { RollingIcon } from "@/components/rolling-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireReviewer } from "@/lib/auth/dal";
import { listQueue, phaseOf, type QueueCard, type QueueColumn } from "@/lib/reports/queue";
import { mascotState, type MascotState } from "@/lib/mascot/states";

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

/**
 * The states something is actively doing, as opposed to one that is waiting.
 *
 * AWAITING_APPROVAL is deliberately absent: nothing is running, it is sitting still until a
 * human answers, and a pulse there would say the opposite. Terminal states are finished.
 */
const RUNNING = new Set(["TRIAGING", "REPRODUCING", "DELIVERING"]);

/**
 * Which mascot stands in for a state something is doing.
 *
 * Only the running three. Agent Bounty appearing on a finished report would be watching
 * something that already stopped, and on one awaiting approval he would be doing the waiting
 * rather than the reviewer.
 */
const MASCOT: Record<string, "ingest" | "reproducing" | "delivered"> = {
  TRIAGING: "ingest",
  REPRODUCING: "reproducing",
  DELIVERING: "delivered",
};

/** What a card in flight is doing, in the present tense, because it is still happening. */
const RUNNING_LABEL: Record<string, string> = {
  TRIAGING: "Triaging",
  REPRODUCING: "Reproducing",
  DELIVERING: "Delivering",
};

/**
 * How each mascot drifts. Distance, tilt, speed and where in the cycle it starts.
 *
 * The negative delays are the point: a positive one would hold every mascot still until its
 * turn came round, while a negative one starts it partway through, so a column of them is out
 * of step from the first frame.
 */
const FLOAT = [
  { y: "-4px", tilt: "2deg", seconds: 3.6, delay: -0.4 },
  { y: "-6px", tilt: "-3deg", seconds: 4.4, delay: -2.1 },
  { y: "-3px", tilt: "3deg", seconds: 3.1, delay: -1.3 },
  { y: "-5px", tilt: "-2deg", seconds: 5.2, delay: -3.4 },
  { y: "-7px", tilt: "1deg", seconds: 4.8, delay: -0.9 },
];

/**
 * Which drift a card gets: its position among the mascots on the board, cycling through FLOAT.
 *
 * Hashing the id was the first attempt and it collided three ways out of four, which is what
 * hashing four things into five buckets does. Counting guarantees the property instead of
 * hoping for it: five consecutive mascots never match, and neighbours in a column are always
 * consecutive. Deterministic either way, which server rendering requires.
 */
function driftAt(index: number) {
  return FLOAT[index % FLOAT.length];
}

/** Coarse on purpose. A queue is scanned, and "3h" answers the question "is this stuck". */
function age(from: Date): string {
  const minutes = Math.floor((Date.now() - from.getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function Card({
  card,
  showState,
  mascot,
  index,
}: {
  card: QueueCard;
  showState: boolean;
  mascot?: MascotState;
  index: number;
}) {
  const phase = phaseOf(card.state);
  const running = RUNNING.has(card.state);
  const float = driftAt(index);

  const status = card.awaitingVerdictId
    ? "Needs review"
    : running
      ? RUNNING_LABEL[card.state]
      : card.outcome
        ? OUTCOME[card.outcome] ?? card.outcome
        : "No verdict yet";

  return (
    <li
      // The sidebar links here. scroll-mt clears the sticky header, and the ring is the :target
      // pseudo-class, so the highlight needs no state and clears itself on the next navigation.
      id={`report-${card.id}`}
      className="flex scroll-mt-24 flex-col gap-3 rounded-xl border border-border/50 bg-card p-4 target:border-brand"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {/* Two lines and then an ellipsis. A report title is written by whoever filed it and
              has no length anyone here controls, so the card decides how much of it fits. */}
          <span
            title={card.title}
            className="line-clamp-2 text-body font-medium text-foreground underline-offset-4 transition-colors hover:text-brand-soft hover:underline"
          >
            {card.title}
          </span>
          {/* One line. The source and the target are an identifier, and an identifier that
              wraps mid-token reads as two things rather than one. */}
          <span
            title={`${card.sourceLabel} · ${card.targetName ?? "no target bound"}`}
            className="line-clamp-1 text-meta break-all text-muted-foreground"
          >
            {card.sourceLabel} · {card.targetName ?? "no target bound"}
          </span>
        </div>

        {/* Every id in the file is prefixed with the state key, so re-prefixing with this
            card's id keeps two cards in the same state from sharing them. Without it the
            second copy's animation would drive the first. */}
        {mascot ? (
          <span
            aria-hidden="true"
            className="animate-mascot-float -my-2 size-20 shrink-0 motion-reduce:animate-none [&>svg]:block [&>svg]:size-full"
            style={{
              animationDuration: `${float.seconds}s`,
              animationDelay: `${float.delay}s`,
              ["--float-y" as string]: float.y,
              ["--float-tilt" as string]: float.tilt,
            }}
            dangerouslySetInnerHTML={{
              __html: mascot.markup.replaceAll(
                `${mascot.key}__`,
                `${mascot.key}__${card.id.slice(0, 8)}__`,
              ),
            }}
          />
        ) : null}
      </div>

      {showState ? (
        <Badge variant={card.state === "DELIVERED" ? "success" : "outline"}>
          {STATE_LABEL[card.state] ?? card.state}
        </Badge>
      ) : null}

      {/* A rule, because this line is a different kind of thing from the two above it: those
          identify the report, this one says where it has got to. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border/50 pt-3">
        {/* The phase, and the outcome or the honest absence of one. Never a canary or a
            confidence: no reproduction has run, so the card has nothing to say about one. */}
        <span className="flex items-center gap-2 text-meta text-muted-foreground">
          {running ? <PhaseSpinner phase={phase} /> : <PhaseDot phase={phase} />}
          {status}
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
          className="mt-1 w-full justify-center"
        >
          Review evidence <RollingIcon icon={ArrowRight} className="size-3.5" />
        </Button>
      ) : null}
    </li>
  );
}

function Column({
  column,
  mascots,
  drift,
}: {
  column: QueueColumn;
  mascots: Map<string, MascotState>;
  drift: Map<string, number>;
}) {
  const hidden = column.total - column.cards.length;

  return (
    // The last column has no rule, so without a transparent one in its place its cards
    // come out a pixel wider than everyone else's.
    <section className="flex flex-col gap-3 px-5 last:border-r last:border-r-transparent">
      <header className="flex items-center gap-2.5">
        <PhaseDot phase={column.key} />
        <h2 className="flex-1 text-body font-medium text-foreground">{column.label}</h2>
        <span className="text-meta text-muted-foreground">{column.total}</span>
      </header>

      {column.cards.length === 0 ? (
        <p className="rounded-xl border border-border/50 border-dashed bg-card/40 px-4 py-6 text-center text-meta text-muted-foreground">
          Nothing here
        </p>
      ) : null}

      <ul className="flex flex-col gap-2.5">
        {column.cards.map((card) => (
          <Card
            key={card.id}
            card={card}
            index={drift.get(card.id) ?? 0}
            showState={column.states.length > 1}
            mascot={mascots.get(card.state)}
          />
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

  // Read once per state rather than once per card: two reports reproducing share the file, and
  // only the ids need to differ, which happens at render.
  const present = new Set(columns.flatMap((c) => c.cards.map((card) => card.state)));
  const mascots = new Map(
    [...present]
      .filter((state) => state in MASCOT)
      .map((state) => [state, mascotState(MASCOT[state])] as const),
  );

  // Numbered across the board rather than within a column, so the drifts stay spread out even
  // when one column holds every mascot on screen.
  const drift = new Map<string, number>();
  for (const column of columns) {
    for (const card of column.cards) {
      if (mascots.has(card.state)) drift.set(card.id, drift.size);
    }
  }

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
        <div className="flex-1 overflow-x-auto px-3 py-8">
          {/* A grid rather than a flex row, so every column is the same height and the rules
              between them run the full board instead of stopping at the tallest stack of
              cards. divide-x draws them, which means no separator element to keep in step
              with the column count. */}
          <div className="grid min-h-full min-w-max auto-cols-[300px] grid-flow-col divide-x divide-border/50">
            {columns.map((column) => (
              <Column key={column.key} column={column} mascots={mascots} drift={drift} />
            ))}
          </div>
        </div>
      )}
    </main>
  );
}

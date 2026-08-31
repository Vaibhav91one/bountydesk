import Link from "next/link";

import { MascotFloat } from "@/components/mascot-float";
import { ArrowRight } from "@phosphor-icons/react/ssr";

import { PhaseDot, PhaseSpinner } from "@/components/phase-dot";
import {
  ReportOutcomeBadge,
  ReportStateBadge,
} from "@/components/report-badges";
import { RollingIcon } from "@/components/rolling-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { phaseOf } from "@/lib/reports/columns";
import type { QueueCard, QueueColumn } from "@/lib/reports/queue";
import type { MascotState } from "@/lib/mascot/states";

/**
 * Which states get Agent Bounty on the card: every one still in the pipeline.
 *
 * The terminal states are left bare on purpose. A finished report is a record rather than
 * something being worked on, and a column of mascots for work nobody is doing would make the
 * board's one useful signal, that something is moving, mean nothing.
 *
 * Exported because the caller reads the mascot files, once per state rather than once per
 * card, and needs to know which states are worth reading.
 */
export const MASCOT_ON_CARD = new Set([
  "TRIAGING",
  "REPRODUCING",
  "ANALYSIS_ONLY",
  "AWAITING_APPROVAL",
  "DELIVERING",
]);

/**
 * How the review queue draws itself.
 *
 * Lifted out of the board page so the landing page can show the real thing rather than a
 * drawing of it. Nothing here reads the database: it takes the rows it is given, which is what
 * lets one caller pass a live snapshot and another pass an example.
 */

/**
 * The states something is actively doing, as opposed to one that is waiting.
 *
 * AWAITING_APPROVAL is deliberately absent: nothing is running, it is sitting still until a
 * human answers, and a pulse there would say the opposite. Terminal states are finished.
 */
const RUNNING = new Set(["TRIAGING", "REPRODUCING", "DELIVERING"]);

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

export function Card({
  card,
  showState,
  mascot,
  index,
  linkPrefetch = true,
}: {
  card: QueueCard;
  showState: boolean;
  mascot?: MascotState;
  index: number;
  linkPrefetch?: boolean;
}) {
  const phase = phaseOf(card.state);
  const failedDelivery = card.deliveryState === "FAILED";
  const running = !failedDelivery && RUNNING.has(card.state);
  const float = driftAt(index);

  const status = card.awaitingVerdictId
    ? "Needs review"
    : failedDelivery
      ? "Delivery failed"
    : running
      ? RUNNING_LABEL[card.state]
      : card.state === "DELIVERED"
        ? "Comment delivered"
      : card.outcome
        ? "Verdict drafted"
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
              has no length anyone here controls, so the card decides how much of it fits.

              The title is the link, rather than the whole card: a card carries a button of its
              own, and nesting one inside a link is invalid markup that browsers resolve by
              guessing. */}
          <Link
            href={`/reports/${card.id}`}
            prefetch={linkPrefetch}
            title={card.title}
            className="line-clamp-2 cursor-pointer text-body font-medium text-foreground underline-offset-4 transition-colors hover:text-brand-soft hover:underline"
          >
            {card.title}
          </Link>
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
          <MascotFloat
            // Every id in the file is prefixed with the state key, so re-prefixing with this
            // card's id keeps two cards in the same state from sharing them. Without it the
            // second copy's animation would drive the first.
            markup={mascot.markup.replaceAll(
              `${mascot.key}__`,
              `${mascot.key}__${card.id.slice(0, 8)}__`,
            )}
            seconds={float.seconds}
            delay={float.delay}
            y={float.y}
            tilt={float.tilt}
          />
        ) : null}
      </div>

      {showState || card.investigating || card.outcome ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {showState ? (
            <ReportStateBadge
              state={card.state}
              phase={phase}
              deliveryState={card.deliveryState}
            />
          ) : null}
          {card.outcome ? <ReportOutcomeBadge outcome={card.outcome} /> : null}
          {/* Nothing in the report's own state distinguishes "queued" from "an agent is
              actively working this right now" -- this badge is that difference. */}
          {card.investigating ? <Badge variant="secondary">Agent investigating</Badge> : null}
        </div>
      ) : null}

      {/* A rule, because this line is a different kind of thing from the two above it: those
          identify the report, this one says where it has got to. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border/50 pt-3">
        {/* The phase, and the outcome or the honest absence of one. Never a canary or a
            confidence: no reproduction has run, so the card has nothing to say about one. */}
        <span className="flex items-center gap-2 text-meta text-muted-foreground">
          {running ? (
            <PhaseSpinner phase={phase} />
          ) : (
            <PhaseDot phase={phase} />
          )}
          {status}
        </span>
        <span className="text-meta text-muted-foreground">
          {card.eventCount} {card.eventCount === 1 ? "event" : "events"} ·{" "}
          {age(card.updatedAt)}
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
          render={<Link href={`/reports/${card.id}`} prefetch={linkPrefetch} />}
          className="mt-1 w-full justify-center"
        >
          Review evidence <RollingIcon icon={ArrowRight} className="size-3.5" />
        </Button>
      ) : null}
    </li>
  );
}

export function Column({
  column,
  mascots,
  drift,
  linkPrefetch = true,
}: {
  column: QueueColumn;
  mascots: Map<string, MascotState>;
  drift: Map<string, number>;
  linkPrefetch?: boolean;
}) {
  const hidden = column.total - column.cards.length;

  return (
    // The last column has no rule, so without a transparent one in its place its cards
    // come out a pixel wider than everyone else's.
    <section className="flex flex-col gap-3 px-5 last:border-r last:border-r-transparent">
      <header className="flex items-center gap-2.5">
        <PhaseDot phase={column.key} />
        <h2 className="flex-1 text-body font-medium text-foreground">
          {column.label}
        </h2>
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
            linkPrefetch={linkPrefetch}
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

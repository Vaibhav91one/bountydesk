"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Files, Gear, ShareNetwork, Tray } from "@phosphor-icons/react/ssr";

import { RollingIcon } from "@/components/rolling-icon";
import type { HomeSummary } from "@/lib/home/summary";
import {
  AMBIENT_REFETCH_MS,
  fetchLive,
  homeSummaryQueryKey,
} from "@/lib/reports/status-query";
import { cn } from "@/lib/utils";

/**
 * A door to a screen, with the count behind it.
 *
 * Every number comes from the database. A card that guessed, or that showed a placeholder
 * while it loaded, would be the one thing on this page a person could not act on.
 */
function RouteCard({
  href,
  icon,
  title,
  body,
  stats,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  body: string;
  stats: { label: string; value: number; urgent?: boolean }[];
}) {
  return (
    <Link
      href={href}
      className="group/button flex flex-col gap-3.5 rounded-xl border border-border/50 bg-card p-5 transition-colors hover:border-border hover:bg-muted/20"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex size-10 items-center justify-center rounded-lg border bg-background">
          {icon}
        </span>
        <RollingIcon icon={ArrowRight} className="size-4 text-muted-foreground" />
      </div>

      <div className="flex flex-col gap-1.5">
        <h2 className="text-heading text-foreground">{title}</h2>
        <p className="text-body text-muted-foreground">{body}</p>
      </div>

      <div className="mt-auto flex flex-wrap items-baseline gap-x-5 gap-y-1 pt-1">
        {stats.map((stat) => (
          <span key={stat.label} className="flex items-baseline gap-1.5">
            <span
              className={cn(
                "text-heading tabular-nums",
                // Amber only where a reviewer is actually the blocker. A count of zero is
                // not urgent, and colouring it would cry wolf on an empty queue.
                stat.urgent ? "text-phase-approval" : "text-foreground",
              )}
            >
              {stat.value}
            </span>
            <span className="text-meta text-muted-foreground">{stat.label}</span>
          </span>
        ))}
      </div>
    </Link>
  );
}

/**
 * The four doors, with the counts behind them kept current.
 *
 * Only the numbers move, so only the numbers are fetched. The counts a reviewer actually acts
 * on ("need you" especially) used to sit here unchanged until somebody navigated, which made
 * the one screen meant to answer "is there work waiting" the least likely to know.
 *
 * The connections figures come from the page as props rather than from this query: they change
 * when somebody installs or suspends the GitHub App, which is not something that happens while
 * you are looking at the page.
 */
export function HomeCountsLive({
  initial,
  granted,
  accepting,
}: {
  initial: HomeSummary;
  granted: number;
  accepting: number;
}) {
  const { data: summary = initial } = useQuery({
    queryKey: homeSummaryQueryKey(),
    queryFn: () => fetchLive<HomeSummary>("/api/home"),
    initialData: initial,
    // A flat interval: this is a set of counts with no lifecycle state to reason about, so
    // there is nothing here that can be finished the way a list of reports can.
    refetchInterval: AMBIENT_REFETCH_MS,
  });

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:col-span-2">
      <RouteCard
        href="/board"
        icon={<Tray className="size-5" />}
        title="Review queue"
        body="Every report by phase, from triage through to the ones that are finished."
        stats={[
          { label: "open", value: summary.open },
          { label: "need you", value: summary.awaiting, urgent: summary.awaiting > 0 },
        ]}
      />

      <RouteCard
        href="/reports"
        icon={<Files className="size-5" />}
        title="Reports"
        body="Everything that has arrived, whatever state it ended in."
        stats={[
          { label: "total", value: summary.reports },
          { label: "closed", value: summary.reports - summary.open },
        ]}
      />

      <RouteCard
        href="/connections"
        icon={<ShareNetwork className="size-5" />}
        title="Connections"
        body="Which repositories are admissible, and what each is bound to."
        stats={[
          { label: "granted", value: granted },
          { label: "accepting", value: accepting },
        ]}
      />

      <RouteCard
        href="/settings"
        icon={<Gear className="size-5" />}
        title="Settings"
        body="What the guard enforces, and what has been signed."
        stats={[
          { label: "targets", value: summary.targets },
          { label: "decisions", value: summary.decisions },
        ]}
      />
    </div>
  );
}

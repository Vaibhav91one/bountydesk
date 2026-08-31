import Link from "next/link";
import { Gmail, GitHubLight, OneDrive } from "developer-icons";
import {
  ArrowRight,
  Check,
  CheckCircle,
  Files,
  Folder,
  Gear,
  Plus,
  ShareNetwork,
  Tray,
} from "@phosphor-icons/react/ssr";

import { Badge } from "@/components/ui/badge";
import { RollingIcon } from "@/components/rolling-icon";
import { Button } from "@/components/ui/button";
import { requireReviewer } from "@/lib/auth/dal";
import { installUrl } from "@/lib/auth/oauth";
import { listConnections } from "@/lib/github/connections";
import { readHomeSummary } from "@/lib/home/summary";
import { cn } from "@/lib/utils";
import { AnimatedMascotSvg } from "@/components/animated-mascot-svg";

export const metadata = { title: "Home · BountyDesk" };

/**
 * Report sources, in the order they are likely to matter.
 *
 * `state` is what is true today: GitHub is the only one wired. developer-icons carries no
 * Google Drive, so OneDrive stands in for the brand, and a folder is not a brand at all so it
 * comes from Phosphor.
 */
const INTEGRATIONS = [
  { key: "github", name: "GitHub", icon: GitHubLight, state: "not connected" },
  { key: "drive", name: "Drive", icon: OneDrive, state: "coming soon" },
  { key: "email", name: "Email", icon: Gmail, state: "coming soon" },
  { key: "upload", name: "File upload", icon: Folder, state: "coming soon" },
] as const;

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

export default async function HomePage() {
  await requireReviewer();
  // Two reads rather than one snapshot, deliberately: the GitHub grant and the report counts
  // describe different things and no card claims a relationship between them. readHomeSummary
  // takes its own transaction, so the numbers that do sit beside each other agree.
  const [connections, summary] = await Promise.all([listConnections(), readHomeSummary()]);

  const live = connections.filter((c) => !c.suspendedAt);
  const repositories = live.flatMap((c) => c.repositories);
  const admissible = repositories.filter((r) => r.status === "admissible");

  return (
    <main className="flex flex-1 flex-col gap-8 p-8">
      <header className="flex items-center gap-4">
        <AnimatedMascotSvg
          state="idle"
          scope="home"
          className="size-24 shrink-0 [&>svg]:block [&>svg]:size-full"
        />
        <div className="flex flex-col gap-2">
          {/* brand-soft rather than --brand: the accent at full strength is a 3:1 on this
              background, and a page title is not the place to lose contrast. */}
          <h1 className="text-title text-brand-soft">Agent Bounty is on the case</h1>
          <p className="max-w-3xl text-lead text-muted-foreground">
            Agent Bounty reads every report, checks whether the bug is real by running it in a
            throwaway copy of your app, and drafts the reply. Nothing goes out until you
            approve the exact words.
          </p>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* The integrations card is its own shape rather than a SetupCard: it leads with the
            sources rather than with one icon and a paragraph. Only GitHub is wired, so the
            rest are visibly inactive instead of implying a connection that does not exist. */}
        <section className="flex flex-col gap-4 rounded-xl border border-border/50 bg-card p-5">
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-2xl font-medium text-foreground">Integrations</h2>
              {live.length > 0 ? (
                <Badge variant="success">
                  <CheckCircle />
                  Connected
                </Badge>
              ) : null}
            </div>
            <p className="text-meta text-muted-foreground">
              Reports arrive from a connected GitHub repository. Email and file upload are
              designed channels, not wired yet.
            </p>
          </div>

          <ul className="flex flex-1 flex-wrap content-center items-center gap-2.5">
            {INTEGRATIONS.map((source) => {
              const connected = source.key === "github" && live.length > 0;
              return (
                <li
                  key={source.key}
                  title={connected ? `${source.name}, connected` : `${source.name}, ${source.state}`}
                  className="relative flex size-14 items-center justify-center rounded-xl border bg-background"
                >
                  <source.icon className="size-7" />
                  {/* Connected is marked by adding something, not by dimming the rest. A tile
                      at 40% opacity reads as broken; a tick reads as a state. */}
                  {connected ? (
                    <span className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-emerald-950">
                      <Check weight="bold" className="size-3 text-emerald-400" />
                    </span>
                  ) : null}
                  <span className="sr-only">
                    {source.name}: {connected ? "connected" : source.state}
                  </span>
                </li>
              );
            })}
          </ul>

          {live.length > 0 ? (
            <Button size="sm" nativeButton={false} render={<Link href="/integrations" />}>
              Manage integrations <RollingIcon icon={ArrowRight} className="size-3.5" />
            </Button>
          ) : (
            <Button size="sm" nativeButton={false} render={<a href={installUrl()} />}>
              <RollingIcon icon={Plus} className="size-3.5" /> Install BountyDesk
            </Button>
          )}
        </section>

        {/* One card per screen, each carrying the count behind it. Somewhere to go and how
            much is waiting there; what the product does is the prose below, not here. */}
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
              { label: "granted", value: repositories.length },
              { label: "accepting", value: admissible.length },
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
      </div>
    </main>
  );
}

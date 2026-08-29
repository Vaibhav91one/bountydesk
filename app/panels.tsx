import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Prohibit, Signature } from "@phosphor-icons/react/ssr";

import { PhaseBadge, PhaseDot, PhaseSpinner } from "@/components/phase-dot";
import { RollingIcon } from "@/components/rolling-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { mascotState } from "@/lib/mascot/states";

/**
 * The illustrations on the landing page, built from the product's own tokens.
 *
 * Not screenshots. A screenshot of a pre-launch console rots the week after it is taken, and it
 * rots silently: change a colour token and the product moves while the image does not. These
 * are made of the same tokens the console is, so a palette change moves them too, and they
 * reflow on a phone instead of scaling down to grey mush.
 *
 * Every panel is marked "example" once, in its own corner. None of them shows a canary result,
 * a duration or a resource figure, because no run has produced one. The one panel that
 * describes an unbuilt stage says so on itself, which is what the console already does.
 */

const HASH = "30e7597fc122c1c7ad3a6bc97e70f984";
const TARGET = "juice-shop-v17.3.0";

function Panel({
  label,
  children,
  className,
  header = true,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  /**
   * The small panels keep their caption bar, because a list of rows that looks like data wants
   * saying it is not. The hero panel drops it: it is the first thing on the page and it carries
   * its own honesty in the footer, which reads "Analysis only, nothing ran".
   */
  header?: boolean;
}) {
  return (
    <div
      className={`flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/50 bg-card ${className ?? ""}`}
    >
      {header ? (
        <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-2.5">
          <span className="text-meta text-muted-foreground">{label}</span>
          <span className="text-meta text-muted-foreground/60">Example</span>
        </div>
      ) : null}
      {children}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/50 py-2.5 last:border-b-0">
      <span className="text-meta text-muted-foreground">{label}</span>
      <span className="min-w-0 text-meta text-foreground">{children}</span>
    </div>
  );
}

/** The hero panel: the moment the whole product exists for. */
export function ApprovalPanel() {
  // Prefixed the way every other render site does it, so a second mascot added to this page
  // later cannot have its gradients resolve against this one's.
  const mascot = mascotState("awaiting-approval");
  const speaker = mascot.markup.replaceAll(
    `${mascot.key}__`,
    `${mascot.key}__hero__`,
  );

  return (
    <Panel label="Sign the verdict" header={false}>
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <PhaseBadge phase="awaiting-approval">Awaiting approval</PhaseBadge>
          <span className="min-w-0 truncate text-body font-medium text-foreground">
            Auth bypass via SQL injection on login
          </span>
        </div>

        <div className="flex gap-3 rounded-md border border-border/50 bg-background p-4">
          {/* The same attribution the real verdict card makes, mascot and all: a reviewer
              approving a comment should see at a glance whose words they are. */}
          <span
            aria-hidden="true"
            className="size-11 shrink-0 [&>svg]:block [&>svg]:size-full"
            dangerouslySetInnerHTML={{ __html: speaker }}
          />

          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            <span className="flex items-center gap-1.5">
              <span className="text-meta text-foreground">Agent Bounty</span>
              <span className="text-meta text-muted-foreground">
                drafted this reply
              </span>
            </span>
            <p className="text-body text-foreground">
              <strong className="font-medium">Verdict: analysis only.</strong>{" "}
              BountyDesk could not reproduce this report automatically, so no
              reproduced verdict was produced. A reviewer read the report and
              the run&rsquo;s own event log and is signing this reply by hand.
            </p>
            <span className="flex items-center gap-2 text-body text-muted-foreground">
              <Image src="/logo-small.svg" alt="" width={16} height={16} />
              Signed via BountyDesk.
            </span>
          </div>
        </div>

        <div className="flex flex-col px-1">
          <Row label="Bound target">{TARGET}</Row>
          <Row label="Content hash">
            <span className="font-mono break-all">{HASH}</span>
          </Row>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 px-5 py-3.5">
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="flex items-end gap-0.5">
            <span className="h-2.5 w-1 rounded-full bg-phase-approval" />
            <span className="h-2.5 w-1 rounded-full bg-border" />
            <span className="h-2.5 w-1 rounded-full bg-border" />
          </span>
          <span className="text-meta text-muted-foreground">
            Analysis only, nothing ran
          </span>
        </span>
        {/* Live, and both go to sign-in. A picture of a button that does nothing when you
            press it is worse than no button; pressing this one takes you to the place the real
            gate lives, which is the honest answer to the click. */}
        <span className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            nativeButton={false}
            render={<Link href="/login" />}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <RollingIcon icon={Prohibit} className="size-4" /> Deny
          </Button>
          <Button
            size="sm"
            nativeButton={false}
            render={<Link href="/login" />}
          >
            <RollingIcon icon={Signature} weight="fill" className="size-4" />{" "}
            Approve
          </Button>
        </span>
      </div>
    </Panel>
  );
}





/** The mobile stand-in for SandboxDiagram, which cannot scroll under a finger. */
export function SandboxList() {
  const stages = [
    { kind: "Connected repo", title: "Exact commit" },
    { kind: "Trusted controller", title: "BountyDesk" },
    { kind: "Untrusted build", title: "Build sandbox" },
    { kind: "Target runtime", title: TARGET },
    { kind: "PoC runner", title: "Approved plan" },
    { kind: "External oracle", title: "Canary check" },
  ];

  return (
    <ol className="flex flex-col overflow-hidden rounded-xl border border-border/50 bg-card">
      {stages.map((stage, index) => (
        <li
          key={stage.kind}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/50 px-4 py-3 last:border-b-0"
        >
          <span className="font-mono text-meta text-muted-foreground">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 truncate text-body text-foreground">
            {stage.title}
          </span>
          <span className="shrink-0 text-meta text-muted-foreground">
            {stage.kind}
          </span>
          {index < stages.length - 1 ? (
            <ArrowRight
              aria-hidden="true"
              className="size-3 shrink-0 text-muted-foreground/50"
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * A photograph under a panel, the way a product shot sits on a backdrop.
 *
 * Decorative, so the image carries an empty alt and a wash keeps the panel readable over
 * whatever is behind it. Below md the frame goes: a photo behind a component on a phone is
 * two things competing for 390px.
 */
export function Framed({ src, children }: { src: string; children: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-2xl md:p-6 lg:p-8">
      <Image
        src={src}
        alt=""
        fill
        sizes="(min-width: 1024px) 50vw, 100vw"
        className="hidden object-cover object-center md:block"
      />
      <div aria-hidden="true" className="absolute inset-0 hidden bg-background/40 md:block" />
      <div className="relative overflow-hidden rounded-xl md:shadow-[0_24px_48px_rgba(0,0,0,0.55)]">
        {children}
      </div>
    </div>
  );
}

const QUEUE: {
  column: string;
  phase: string;
  title: string;
  meta: string;
  running?: boolean;
  mascot?: string;
  needsYou?: boolean;
}[] = [
  {
    column: "Reproducing",
    phase: "reproducing",
    title: "SQL injection in /rest/products/search",
    meta: "#175152 · juice-shop-v17.3.0",
    running: true,
    mascot: "reproducing",
  },
  {
    column: "Awaiting approval",
    phase: "awaiting-approval",
    title: "Auth bypass via SQL injection on login",
    meta: "#175156 · analysis only",
    needsYou: true,
    mascot: "awaiting-approval",
  },
  {
    column: "Delivered",
    phase: "delivered",
    title: "Directory traversal in the file upload handler",
    meta: "#175154 · posted to the issue",
    mascot: "celebrating",
  },
];

/**
 * The review queue as it actually moves: a card mid-run spins, the one waiting on a person
 * says so, and Agent Bounty is doing the thing each column names.
 *
 * The whole panel is a link. A board that looked live and did nothing when pressed would be
 * the one dishonest thing on the page, so pressing it goes where the real board lives.
 */
export function QueuePanel() {
  return (
    <Link
      href="/login"
      className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-border/50 bg-card p-4 transition-colors hover:border-border"
    >
      {QUEUE.map((card, index) => (
        <div
          key={card.title}
          className="flex min-w-0 items-center gap-3 rounded-lg border border-border/50 bg-background p-3"
        >
          {card.mascot ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/mascot/${card.mascot}.svg`}
              alt=""
              width={44}
              height={44}
              style={{ animationDelay: `${index * 420}ms`, ["--float-y" as string]: "5px" }}
              className="animate-mascot-float size-11 shrink-0 motion-reduce:animate-none"
            />
          ) : null}

          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-body font-medium text-foreground">{card.title}</span>
            <span className="flex min-w-0 items-center gap-2">
              {card.running ? (
                <PhaseSpinner phase={card.phase} />
              ) : (
                <PhaseDot phase={card.phase} />
              )}
              <span className="truncate text-meta text-muted-foreground">
                {card.column} · {card.meta}
              </span>
            </span>
          </span>

          {card.needsYou ? (
            <Badge variant="outline" className="shrink-0 text-phase-approval">
              <Signature weight="fill" /> You
            </Badge>
          ) : null}
        </div>
      ))}
    </Link>
  );
}

const ROWS: { title: string; source: string; phase: string; state: string; when: string }[] = [
  {
    title: "Auth bypass via SQL injection on login",
    source: "#175156",
    phase: "awaiting-approval",
    state: "Awaiting approval",
    when: "14:23",
  },
  {
    title: "Directory traversal in the file upload handler",
    source: "#175154",
    phase: "delivered",
    state: "Delivered",
    when: "14:23",
  },
  {
    title: "Weak JWT signing key on the login endpoint",
    source: "#175153",
    phase: "analysis-only",
    state: "Analysis only",
    when: "14:23",
  },
  {
    title: "Missing security headers on the marketing site",
    source: "#175155",
    phase: "closed",
    state: "Out of scope",
    when: "14:23",
  },
];

/** Every report, closed ones included, the way the index lists them. */
export function ReportsPanel() {
  return (
    <Link
      href="/login"
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/50 bg-card transition-colors hover:border-border"
    >
      {ROWS.map((row) => (
        <span
          key={row.source}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/50 px-4 py-3 last:border-b-0"
        >
          <PhaseDot phase={row.phase} />
          <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">
            {row.title}
          </span>
          <PhaseBadge phase={row.phase} className="shrink-0">
            {row.state}
          </PhaseBadge>
          <span className="shrink-0 font-mono text-meta text-muted-foreground">{row.when}</span>
        </span>
      ))}
    </Link>
  );
}

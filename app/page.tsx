import Image from "next/image";
import Link from "next/link";
import { Folder, Sparkle } from "@phosphor-icons/react/ssr";
import { Gmail, GitHubLight, OneDrive } from "developer-icons";

import { RollingIcon } from "@/components/rolling-icon";
import { MASCOT_ON_CARD } from "@/components/queue-board";
import { Parallax } from "@/components/parallax";
import { Reveal } from "@/components/reveal";
import { TopBar } from "@/components/top-bar";
import { TextAnimate } from "@/components/ui/text-animate";
import { SandboxDiagram } from "@/components/sandbox-diagram";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { MarqueeAlongSvgPath } from "@/components/ui/marquee-along-svg-path";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MASCOT_FOR_STATE } from "@/lib/mascot/catalog";

import {
  INTEGRATIONS,
  type IntegrationIcon,
} from "./(app)/integrations/catalog";
import { Faq } from "./faq";
import { Inert } from "./queue-demo";
import { QueuePreview } from "./queue-preview";
import { ReportsTable } from "./(app)/reports/reports-table";
import { ApprovalPanel, Framed, SandboxList } from "./panels";

export const metadata = {
  title: "BountyDesk",
  description:
    "Automated bug-bounty triage: reproduce a report against a pinned target, ship a verdict only after a human approves the exact words.",
};

const SOURCE = "https://github.com/Vaibhav91one/bountydesk";

/**
 * Example rows for the two real components below.
 *
 * The interface is the product's own, not a drawing of it, so it needs the shape the product
 * feeds it. These are the seeded demo reports, and nothing here claims a canary was observed:
 * the one that ran is reproducing, and the rest carry the outcomes the enum allows.
 */
const AT = new Date("2026-08-29T14:23:00Z");

/**
 * The width the previews lay their interface out at before it is scaled down.
 *
 * Narrower than a real desktop, because the frame is taller than it is wide and a 1280px
 * layout scaled to fit that width would leave most of the height empty.
 */
/**
 * The order the page introduces itself in, in seconds.
 *
 * Kept in one table because the whole point is the sequence, and a set of delays scattered
 * across five elements is a sequence nobody can read. The heading is first and the furniture
 * is last: the claim arrives, then the proof, then the navigation.
 *
 * Everything but the heading rides CSS, so it animates off the prerendered HTML instead of
 * waiting for hydration.
 */
const ENTRANCE = {
  headingSecondLine: 0.25,
  subheading: 0.45,
  buttons: 0.65,
  backdrop: 0.85,
  /** The header's own delay lives in site-header.tsx, since it owns the class. */
  cardStep: 0.09,
} as const;

const DESIGN_WIDTH = 700;

/** The height every preview fills, which is the frame's content box at desktop. */
const PREVIEW_HEIGHT = 460;

const QUEUE_COLUMNS = [
  {
    key: "triaging",
    label: "Triaging",
    total: 2,
    cards: [
      {
        id: "t1",
        title: "Stored XSS in the product review field",
        sourceLabel: "#175151",
        targetName: "juice-shop-v17.3.0",
        state: "TRIAGING",
        outcome: null,
        deliveryState: null,
        handoffFailed: false,
        eventCount: 1,
        updatedAt: AT.toISOString(),
        awaitingVerdictId: null,
      },
      {
        id: "t2",
        title: "Reflected XSS in the search results page",
        sourceLabel: "#175157",
        targetName: "juice-shop-v17.3.0",
        state: "TRIAGING",
        outcome: null,
        deliveryState: null,
        handoffFailed: false,
        eventCount: 1,
        updatedAt: AT.toISOString(),
        awaitingVerdictId: null,
      },
    ],
  },
  {
    key: "reproducing",
    label: "Reproducing",
    total: 2,
    cards: [
      {
        id: "r1",
        title: "SQL injection in /rest/products/search",
        sourceLabel: "#175152",
        targetName: "juice-shop-v17.3.0",
        state: "REPRODUCING",
        outcome: null,
        deliveryState: null,
        handoffFailed: false,
        eventCount: 2,
        updatedAt: AT.toISOString(),
        awaitingVerdictId: null,
      },
      {
        id: "r2c",
        title: "Unrestricted file type on the complaint upload",
        sourceLabel: "#175158",
        targetName: "juice-shop-v17.3.0",
        state: "REPRODUCING",
        outcome: null,
        deliveryState: null,
        handoffFailed: false,
        eventCount: 2,
        updatedAt: AT.toISOString(),
        awaitingVerdictId: null,
      },
    ],
  },
  {
    key: "awaiting-approval",
    label: "Awaiting approval",
    total: 2,
    cards: [
      {
        id: "a1",
        title: "Auth bypass via SQL injection on login",
        sourceLabel: "#175156",
        targetName: "juice-shop-v17.3.0",
        state: "AWAITING_APPROVAL",
        outcome: "NOT_REPRODUCED",
        deliveryState: null,
        handoffFailed: false,
        eventCount: 3,
        updatedAt: AT.toISOString(),
        awaitingVerdictId: "v1",
      },
      {
        id: "a2",
        title: "IDOR on the basket endpoint",
        sourceLabel: "#175159",
        targetName: "juice-shop-v17.3.0",
        state: "AWAITING_APPROVAL",
        outcome: "REPRODUCED",
        deliveryState: null,
        handoffFailed: false,
        eventCount: 4,
        updatedAt: AT.toISOString(),
        awaitingVerdictId: "v2",
      },
    ],
  },
] as unknown as Parameters<typeof QueuePreview>[0]["columns"];

/** The one card that moves, shown in whichever of the first two columns currently holds it. */
const TRAVELLER = {
  id: "moving",
  title: "Weak JWT signing key on the login endpoint",
  sourceLabel: "#175153",
  targetName: "juice-shop-v17.3.0",
  outcome: null,
  deliveryState: null,
  handoffFailed: false,
  eventCount: 2,
  updatedAt: AT.toISOString(),
  awaitingVerdictId: null,
} as const;

const REPORT_ROWS = [
  {
    id: "r1",
    title: "Auth bypass via SQL injection on login",
    sourceLabel: "#175156",
    targetName: "juice-shop-v17.3.0",
    state: "ANALYSIS_ONLY" as const,
    outcome: "ANALYSIS_ONLY" as const,
    deliveryState: null,
    handoffFailed: false,
    eventCount: 3,
    awaitingVerdictId: "v1",
    investigating: false,
    origin: "Vaibhav91one/juice-shop",
    phase: "analysis-only",
    updatedAt: AT.toISOString(),
    createdAt: AT.toISOString(),
  },
  {
    id: "r2",
    title: "Directory traversal in the file upload handler",
    sourceLabel: "#175154",
    targetName: "juice-shop-v17.3.0",
    state: "DELIVERED" as const,
    outcome: "REPRODUCED" as const,
    deliveryState: "SENT" as const,
    handoffFailed: false,
    eventCount: 3,
    awaitingVerdictId: null,
    investigating: false,
    origin: "Vaibhav91one/juice-shop",
    phase: "delivered",
    updatedAt: AT.toISOString(),
    createdAt: AT.toISOString(),
  },
  {
    id: "r3",
    title: "Weak JWT signing key on the login endpoint",
    sourceLabel: "#175153",
    targetName: null,
    state: "ANALYSIS_ONLY" as const,
    outcome: "ANALYSIS_ONLY" as const,
    deliveryState: null,
    handoffFailed: false,
    eventCount: 3,
    awaitingVerdictId: null,
    investigating: false,
    origin: "Vaibhav91one/juice-shop",
    phase: "analysis-only",
    updatedAt: AT.toISOString(),
    createdAt: AT.toISOString(),
  },
  {
    id: "r4",
    title: "Missing security headers on the marketing site",
    sourceLabel: "#175155",
    targetName: "juice-shop-v17.3.0",
    state: "OUT_OF_SCOPE" as const,
    outcome: null,
    deliveryState: null,
    handoffFailed: false,
    eventCount: 1,
    awaitingVerdictId: null,
    investigating: false,
    origin: "Vaibhav91one/juice-shop",
    phase: "closed",
    updatedAt: AT.toISOString(),
    createdAt: AT.toISOString(),
  },
  {
    id: "r5",
    title: "IDOR on the basket endpoint",
    sourceLabel: "#175159",
    targetName: "juice-shop-v17.3.0",
    state: "AWAITING_APPROVAL" as const,
    outcome: "REPRODUCED" as const,
    deliveryState: null,
    handoffFailed: false,
    eventCount: 4,
    awaitingVerdictId: "v2",
    investigating: false,
    origin: "Vaibhav91one/juice-shop",
    phase: "awaiting-approval",
    updatedAt: AT.toISOString(),
    createdAt: AT.toISOString(),
  },
  {
    id: "r6",
    title: "Unrestricted file type on the complaint upload",
    sourceLabel: "#175158",
    targetName: "juice-shop-v17.3.0",
    state: "REPRODUCING" as const,
    outcome: null,
    deliveryState: null,
    handoffFailed: false,
    eventCount: 2,
    awaitingVerdictId: null,
    investigating: false,
    origin: "Vaibhav91one/juice-shop",
    phase: "reproducing",
    updatedAt: AT.toISOString(),
    createdAt: AT.toISOString(),
  },
  {
    id: "r7",
    title: "Reflected XSS in the search results page",
    sourceLabel: "#175157",
    targetName: "juice-shop-v17.3.0",
    state: "TRIAGING" as const,
    outcome: null,
    deliveryState: null,
    handoffFailed: false,
    eventCount: 1,
    awaitingVerdictId: null,
    investigating: false,
    origin: "Vaibhav91one/juice-shop",
    phase: "triaging",
    updatedAt: AT.toISOString(),
    createdAt: AT.toISOString(),
  },
  {
    id: "r8",
    title: "Rate limit bypass on coupon redemption",
    sourceLabel: "#175160",
    targetName: "juice-shop-v17.3.0",
    state: "DELIVERED" as const,
    outcome: "NOT_REPRODUCED" as const,
    deliveryState: "FAILED" as const,
    handoffFailed: false,
    eventCount: 4,
    awaitingVerdictId: null,
    investigating: false,
    origin: "Vaibhav91one/juice-shop",
    phase: "delivered",
    updatedAt: AT.toISOString(),
    createdAt: AT.toISOString(),
  },
];

/** Every state the splitter writes, in pipeline order. Kept as names, fetched as files. */
const MASCOTS = [
  "idle",
  "ingest",
  "scanning",
  "reproducing",
  "canary-found",
  "awaiting-approval",
  "delivered",
  "celebrating",
  "denied",
  "out-of-scope",
  "infra-hiccup",
  "greeting",
  "chilling",
  "cowboy",
] as const;

const CHANNEL_ICONS: Record<
  IntegrationIcon,
  React.ComponentType<{ className?: string }>
> = {
  github: GitHubLight,
  gmail: Gmail,
  onedrive: OneDrive,
  folder: Folder,
};

/**
 * The front door.
 *
 * A server component that reads no session, so the route stays static. Signing in is one link
 * to /login, which already sends a signed-in visitor to /home, so the page does the right thing
 * for both readers without asking the database who they are.
 *
 * What it must never do is overstate the product. The thesis being sold is that nothing ships
 * until a person approves the exact words, so a front door that oversold itself would be
 * contradicting its own argument. The labels are the product working.
 */
export default function LandingPage() {
  // One mascot per state and one drift index per card, both built the way the board builds
  // them, so the preview and the real thing stagger identically. The traveller is counted
  // because it carries a mascot too.
  const queueStates = [
    ...new Set([
      ...QUEUE_COLUMNS.flatMap((column) =>
        column.cards.map((card) => card.state),
      ),
      "TRIAGING",
      "REPRODUCING",
    ]),
  ];
  const queueMascots = new Map(
    queueStates
      .filter((state) => MASCOT_ON_CARD.has(state))
      .map((state) => [state, MASCOT_FOR_STATE[state]] as const),
  );

  const queueDrift = new Map<string, number>([["moving", 0]]);
  for (const column of QUEUE_COLUMNS) {
    for (const card of column.cards) {
      if (queueMascots.has(card.state))
        queueDrift.set(card.id, queueDrift.size);
    }
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <TopBar>
        <SiteHeader sticky={false} entrance appLinkPrefetch={false} />
      </TopBar>

      <main className="flex flex-1 flex-col">
        {/* Hero. Centred rather than split: the reference puts the headline in the middle of
            the page and the product underneath it on a backdrop, which gives the claim the
            whole width and stops the panel competing with it for attention. */}
        <section className="relative z-10 mx-auto flex w-full max-w-4xl flex-col items-center gap-7 px-6 pt-20 pb-10 text-center lg:pt-24">
          {/* text-display is 64px with no responsive variant, and app/login/page.tsx already
              records why that matters: a 64px headline on a phone is a scroll, not a hero.
              Login hides its headline below lg; a landing page cannot, so this steps up and
              carries the token's weight and tracking at the smaller sizes. */}
          {/* Two TextAnimate spans rather than one string with a break: it splits the text it
              is given, and a newline is not a line break to it. Each line keeps its own
              accessible copy, so the h1 still reads as one sentence. startOnView is off
              because this is the first beat of the load sequence, not something scrolled to. */}
          <h1 className="text-4xl leading-[1.06] font-normal tracking-[-0.03em] text-balance text-foreground sm:text-5xl lg:text-display xl:text-[4.5rem]">
            <TextAnimate
              as="span"
              animation="slideLeft"
              by="character"
              startOnView={false}
              once
              duration={0.6}
              className="block"
            >
              Read every report.
            </TextAnimate>
            <TextAnimate
              as="span"
              animation="slideLeft"
              by="character"
              startOnView={false}
              once
              duration={0.6}
              delay={ENTRANCE.headingSecondLine}
              className="block"
            >
              Sign every verdict.
            </TextAnimate>
          </h1>

          <p
            className="animate-step-in max-w-[760px] text-lead text-muted-foreground motion-reduce:animate-none"
            style={{ animationDelay: `${ENTRANCE.subheading}s` }}
          >
            Every report authenticated and scope-checked. No verdict ships until
            you sign it.
          </p>

          <div
            className="animate-step-in flex flex-wrap items-center justify-center gap-3 motion-reduce:animate-none"
            style={{ animationDelay: `${ENTRANCE.buttons}s` }}
          >
            <Button
              size="lg"
              nativeButton={false}
              render={<Link href="/login" prefetch={false} />}
              className="rounded-full px-6"
            >
              <RollingIcon icon={Sparkle} weight="fill" className="size-4" />{" "}
              Get started
            </Button>
            <Button
              size="lg"
              variant="outline"
              nativeButton={false}
              render={
                <a href={SOURCE} target="_blank" rel="noreferrer noopener" />
              }
              className="rounded-full px-6"
            >
              <RollingIcon icon={GitHubLight} className="size-4" /> Star on
              GitHub
            </Button>
          </div>
        </section>

        {/* The product on a backdrop, the way the reference seats its screenshot. The image is
            decorative, so it carries an empty alt and the panel above it says everything. */}
        <div
          className="animate-step-in relative isolate motion-reduce:animate-none"
          style={{ animationDelay: `${ENTRANCE.backdrop}s` }}
        >
          <div
            aria-hidden="true"
            className="absolute inset-x-0 -top-44 bottom-0 overflow-hidden"
          >
            {/* Headroom above only, and the drift goes one way. The composition puts the
                horizon on the bottom edge, so lifting the picture would open a gap there that
                the gradient does not reach. 10% of 112% travels 11.2%, inside the 12% above. */}
            <Parallax
              from="0%"
              to="10%"
              // This band is on screen the moment the page loads, so its progress at load has
              // to be 0 or the server renders no transform and the picture snaps into place
              // the instant motion hydrates. start-start is 0 exactly where it already sits.
              offset={["start start", "end start"]}
              className="absolute inset-x-0 -top-[12%] h-[112%]"
            >
              <Image
                src="/backdrop/hero.webp"
                alt=""
                fill
                priority
                sizes="100vw"
                className="object-cover object-bottom opacity-75"
              />
            </Parallax>
            {/* Fades the band into the page at both edges, so it reads as one surface rather
                than a photo pasted between two dark blocks. */}
            <div className="absolute inset-0 bg-gradient-to-b from-background from-20% via-background/20 via-60% to-background" />
          </div>

          <div className="relative mx-auto w-full max-w-5xl px-6 pt-10 pb-24 lg:pt-12">
            <ApprovalPanel />
          </div>
        </div>

        {/* Intake channels. The reference puts a logo wall here; ours is the four ways a report
            can arrive, three of which are honestly unavailable. */}
        <section className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 py-20">
          <h2 className="text-title text-foreground">
            Reports arrive from where they arrive
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {INTEGRATIONS.map((channel, index) => {
              const Icon = CHANNEL_ICONS[channel.icon];
              const reason = `channel-${channel.id}`;
              return (
                // Reveal is the li rather than a wrapper inside it, so the grid still sees
                // four children and the cards keep their equal heights.
                <Reveal
                  key={channel.id}
                  delay={index * ENTRANCE.cardStep}
                  render="li"
                  className="flex flex-col gap-3 rounded-xl border border-border/50 bg-card p-5"
                >
                  <span className="flex items-center justify-between gap-3">
                    {/* Full opacity even when the channel is unavailable. A dimmed tile reads
                        as broken; a tile with a caption reads as a state. */}
                    <span className="flex size-10 items-center justify-center rounded-lg border border-border/50 bg-background">
                      <Icon className="size-5" />
                    </span>
                    {channel.built ? (
                      <Badge variant="success">Live</Badge>
                    ) : null}
                  </span>

                  <span className="text-body font-medium text-foreground">
                    {channel.name}
                  </span>

                  {channel.built ? (
                    <Button
                      size="sm"
                      variant="outline"
                      nativeButton={false}
                      render={<Link href="/login" prefetch={false} />}
                      className="w-full justify-center"
                    >
                      <RollingIcon icon={GitHubLight} className="size-4" />{" "}
                      Connect
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled
                      aria-describedby={reason}
                      className="w-full justify-center"
                    >
                      Coming soon
                    </Button>
                  )}

                  {/* Outside the button on purpose. disabled:opacity-50 on top of
                      muted-foreground drops the caption under 4.5:1, and a tooltip cannot fire
                      on a control with pointer-events-none. */}
                  <span id={reason} className="text-meta text-muted-foreground">
                    {channel.tagline}
                  </span>
                </Reveal>
              );
            })}
          </ul>
        </section>

        {/* How it works */}
        <div id="how" className="scroll-mt-28" />

        {/* Agent Bounty, introduced once. The carousel is the existing marquee, which is pure
            CSS: it duplicates the list and translates the track, so there is no client JS and
            nothing to hydrate. Full bleed on purpose, outside the page's max width. */}
        <section className="flex flex-col items-center gap-2 py-24">
          {/* Along a path rather than a straight line. The mascots are <img>, not inlined
              markup: this marquee repeats every child, and the fourteen animated exports are
              1.4MB, so three copies each would be four megabytes of HTML. As files they are
              fetched once, cached, and kept out of the document.

              The path is authored in pixels because CSS offset-path uses the container's own
              coordinates, not the viewBox. Masked at both ends so items arrive and leave
              rather than popping. */}
          <div className="no-scrollbar w-full overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_18%,black_82%,transparent)]">
            <MarqueeAlongSvgPath
              path="M 0,290 A 4100,4100 0 0 1 2200,290"
              viewBox="0 0 2200 280"
              width={2200}
              height={280}
              baseVelocity={2.4}
              repeat={1}
              slowdownOnHover
              draggable
              grabCursor
              enableRollingZIndex={false}
              className="relative left-1/2 w-[2200px] -translate-x-1/2"
            >
              {MASCOTS.map((state) => (
                // next/image cannot optimise SVG without dangerouslyAllowSVG, so it would add
                // a wrapper and a loader for no gain. These are 30 to 100KB local files.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={state}
                  src={`/mascot/${state}.svg`}
                  alt=""
                  width={96}
                  height={96}
                  className="size-28 max-w-none -translate-x-1/2 -translate-y-1/2"
                />
              ))}
            </MarqueeAlongSvgPath>
          </div>

          {/* Pulled up into the marquee's own empty lower half. The path arcs about 150px
              higher in the middle than at its ends, so the box is tall enough for the mascots
              that sit low near the edges while the region directly above this heading holds
              nothing. Spacing the text off the bottom of that box left a gap the eye reads as
              a mistake. */}
          <div className="-mt-28 flex max-w-2xl flex-col items-center gap-4 px-6 text-center">
            <TextAnimate
              as="h2"
              animation="scaleUp"
              by="text"
              once
              className="text-4xl font-normal tracking-[-0.02em] text-foreground sm:text-5xl"
            >
              Meet Agent Bounty
            </TextAnimate>
            <p className="text-lead text-muted-foreground">
              It reads every report, checks it against the target the server
              pins, and drafts the reply. What it never does is decide: the
              verdict comes from the oracle, and the words that go out are the
              ones you signed.
            </p>
          </div>
        </section>

        <Feature
          eyebrow="Reproduction"
          title="Two sandboxes, and an oracle outside both"
          body="A dynamic run builds in one sandbox with narrow dependency egress and reproduces in a second with none, and only the built artifact crosses between them. A fresh canary is seeded through a trusted fixture, a negative control runs first, and the oracle that decides runs outside the sandbox it is judging."
          visual={
            <>
              {/* The diagram sets touch-none across a 460px band, which on a phone is a place
                  a scrolling finger gets stuck. The list below says the same thing and
                  scrolls, which is why the framed half starts at md. */}
              <div className="hidden md:block">
                <Framed src="/backdrop/panel.webp">
                  <SandboxDiagram
                    repositoryFullName="Vaibhav91one/juice-shop"
                    targetName="juice-shop-v17.3.0"
                    sandboxId="daytona-demo"
                  />
                </Framed>
              </div>

              <div className="md:hidden">
                <SandboxList />
              </div>
            </>
          }
        />

        <Feature
          reverse
          eyebrow="Review queue"
          title="Work in flight, by phase"
          body="Six columns, and a card that is mid-run says so: the phase spins rather than sitting still, and Agent Bounty is doing the thing the column names. The one waiting on a person is marked, and only when there is a call a reviewer can actually answer."
          visual={
            <Framed src="/backdrop/queue.webp">
              <Preview height={630}>
                <Inert>
                  <div className="h-full rounded-xl border border-border/50 bg-card p-4">
                    <QueuePreview
                      columns={QUEUE_COLUMNS}
                      traveller={
                        TRAVELLER as unknown as Parameters<
                          typeof QueuePreview
                        >[0]["traveller"]
                      }
                      mascots={queueMascots}
                      drift={queueDrift}
                      linkPrefetch={false}
                    />
                  </div>
                </Inert>
              </Preview>
            </Framed>
          }
        />

        <Feature
          eyebrow="Reports"
          title="Everything that arrived, however it ended"
          body="The board hides closed work on purpose, so the index is the list that hides nothing. Search across title, issue and repository, filter to what is open or what is waiting on you, and open any of them straight into its case file."
          visual={
            <Framed src="/backdrop/reports.webp">
              <Preview height={630}>
                <Inert>
                  <ReportsTable rows={REPORT_ROWS} />
                </Inert>
              </Preview>
            </Framed>
          }
        />

        {/* FAQ */}
        <section
          id="faq"
          className="mx-auto grid w-full max-w-7xl scroll-mt-28 gap-10 px-6 py-24 lg:grid-cols-[320px_1fr]"
        >
          <div className="flex flex-col gap-3">
            <h2 className="text-title text-foreground">
              Frequently
              <br className="hidden lg:block" /> asked questions
            </h2>
            <p className="text-body text-muted-foreground">
              Answers come from the design record, not from a marketing draft.
            </p>
          </div>
          <Faq />
        </section>
      </main>

      <SiteFooter appLinkPrefetch={false} />
    </div>
  );
}

/**
 * A desktop interface shown at the size a half-column allows.
 *
 * Scaled rather than rebuilt: the two components inside are the ones the console renders, so a
 * smaller copy of them cannot drift from the product the way a drawing would. Laid out at
 * desktop width and then transformed, which keeps the type and spacing in their real
 * proportion instead of reflowing into something the product never looks like.
 */
function Preview({
  height,
  children,
}: {
  /** The interface's own height at DESIGN_WIDTH, which sets the scale. */
  height: number;
  children: React.ReactNode;
}) {
  return (
    // An opaque ground, so the interface reads as a window sitting on the photograph rather
    // than a translucent overlay: the table paints its own card, but the search field and the
    // filter chips are transparent and the picture came through them.
    <div
      className="flex w-full items-center justify-center overflow-hidden rounded-xl bg-background"
      style={{ height: PREVIEW_HEIGHT }}
    >
      {/* Laid out at desktop width and then scaled, which keeps the type and spacing in their
          real proportion instead of reflowing into something the product never looks like.

          The box is a fixed size, not the content's. A transform does not change layout, so
          the queue's own height still grows and shrinks by a hundred pixels as the card
          changes column, and letting that through would resize the photograph behind it on a
          loop. Scaled by height because that is the dimension the frame fixes; DESIGN_WIDTH is
          then chosen so the width lands on the frame's at desktop. */}
      <div
        className="shrink-0"
        style={{
          width: DESIGN_WIDTH,
          height,
          transform: `scale(${PREVIEW_HEIGHT / height})`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * One feature: prose on one side, an illustration on the other, alternating down the page.
 *
 * The visual comes after the prose in the DOM whichever side it lands on, so the reading order
 * stays prose-first when the grid collapses to one column.
 */
function Feature({
  eyebrow,
  title,
  body,
  visual,
  reverse,
}: {
  eyebrow: string;
  title: string;
  body: string;
  visual: React.ReactNode;
  reverse?: boolean;
}) {
  return (
    <section className="mx-auto grid w-full max-w-7xl items-center gap-10 px-6 py-20 lg:grid-cols-2 lg:gap-16 lg:py-24">
      <div
        className={`flex min-w-0 flex-col items-start ${reverse ? "lg:order-2" : ""}`}
      >
        {/* Mono and sentence case, in the accent, with a little air under it so it reads as a
            label above the heading rather than the first line of it. */}
        <span className="font-mono text-body text-brand-soft pb-2">
          {eyebrow}
        </span>
        <h2 className="text-3xl leading-[1.15] font-normal tracking-[-0.02em] text-foreground sm:text-4xl">
          {title}
        </h2>
        <p className="mt-7 max-w-[560px] text-lead text-muted-foreground">
          {body}
        </p>
      </div>
      <div className={`min-w-0 ${reverse ? "lg:order-1" : ""}`}>{visual}</div>
    </section>
  );
}

import Image from "next/image";
import Link from "next/link";
import { Folder, Sparkle } from "@phosphor-icons/react/ssr";
import { Gmail, GitHubLight, OneDrive } from "developer-icons";

import { RollingIcon } from "@/components/rolling-icon";
import { SandboxDiagram } from "@/components/sandbox-diagram";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { MarqueeAlongSvgPath } from "@/components/ui/marquee-along-svg-path";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { INTEGRATIONS, type IntegrationIcon } from "./(app)/integrations/catalog";
import { Faq } from "./faq";
import {
  ApprovalPanel,
  Framed,
  QueuePanel,
  ReportsPanel,
  SandboxList,
} from "./panels";

export const metadata = {
  title: "BountyDesk",
  description:
    "Automated bug-bounty triage: reproduce a report against a pinned target, ship a verdict only after a human approves the exact words.",
};

const SOURCE = "https://github.com/Vaibhav91one/bountydesk";

/** Every state the splitter writes, in pipeline order. Kept as names, fetched as files. */
const MASCOTS = [
  "idle", "ingest", "scanning", "reproducing", "canary-found", "awaiting-approval",
  "delivered", "celebrating", "denied", "out-of-scope", "infra-hiccup", "greeting",
  "chilling", "cowboy",
] as const;

const CHANNEL_ICONS: Record<IntegrationIcon, React.ComponentType<{ className?: string }>> = {
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
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader />

      <main className="flex flex-1 flex-col">
        {/* Hero. Centred rather than split: the reference puts the headline in the middle of
            the page and the product underneath it on a backdrop, which gives the claim the
            whole width and stops the panel competing with it for attention. */}
        <section className="relative z-10 mx-auto flex w-full max-w-4xl flex-col items-center gap-7 px-6 pt-20 pb-10 text-center lg:pt-24">
          {/* text-display is 64px with no responsive variant, and app/login/page.tsx already
              records why that matters: a 64px headline on a phone is a scroll, not a hero.
              Login hides its headline below lg; a landing page cannot, so this steps up and
              carries the token's weight and tracking at the smaller sizes. */}
          <h1 className="text-4xl leading-[1.06] font-normal tracking-[-0.03em] text-balance text-foreground sm:text-5xl lg:text-display xl:text-[4.5rem]">
            Read every report.
            <br />
            Sign every verdict.
          </h1>

          <p className="max-w-[760px] text-lead text-muted-foreground">
            Every report authenticated and scope-checked. No verdict ships until you sign it.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button
              size="lg"
              nativeButton={false}
              render={<Link href="/login" />}
              className="rounded-full px-6"
            >
              <RollingIcon icon={Sparkle} weight="fill" className="size-4" /> Get started
            </Button>
            <Button
              size="lg"
              variant="outline"
              nativeButton={false}
              render={<a href={SOURCE} target="_blank" rel="noreferrer noopener" />}
              className="rounded-full px-6"
            >
              <RollingIcon icon={GitHubLight} className="size-4" /> Star on GitHub
            </Button>
          </div>
        </section>

        {/* The product on a backdrop, the way the reference seats its screenshot. The image is
            decorative, so it carries an empty alt and the panel above it says everything. */}
        <div className="relative isolate">
          <div aria-hidden="true" className="absolute inset-x-0 -top-44 bottom-0 overflow-hidden">
            <Image
              src="/backdrop/hero.webp"
              alt=""
              fill
              priority
              sizes="100vw"
              className="object-cover object-bottom opacity-75"
            />
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
          <h2 className="text-title text-foreground">Reports arrive from where they arrive</h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {INTEGRATIONS.map((channel) => {
              const Icon = CHANNEL_ICONS[channel.icon];
              const reason = `channel-${channel.id}`;
              return (
                <li
                  key={channel.id}
                  className="flex flex-col gap-3 rounded-xl border border-border/50 bg-card p-5"
                >
                  <span className="flex items-center justify-between gap-3">
                    {/* Full opacity even when the channel is unavailable. A dimmed tile reads
                        as broken; a tile with a caption reads as a state. */}
                    <span className="flex size-10 items-center justify-center rounded-lg border border-border/50 bg-background">
                      <Icon className="size-5" />
                    </span>
                    {channel.built ? <Badge variant="success">Live</Badge> : null}
                  </span>

                  <span className="text-body font-medium text-foreground">{channel.name}</span>

                  {channel.built ? (
                    <Button
                      size="sm"
                      variant="outline"
                      nativeButton={false}
                      render={<Link href="/login" />}
                      className="w-full justify-center"
                    >
                      <RollingIcon icon={GitHubLight} className="size-4" /> Connect
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
                </li>
              );
            })}
          </ul>
        </section>

        {/* How it works */}
        <div id="how" className="scroll-mt-20" />

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

          <div className="flex max-w-2xl flex-col items-center gap-4 px-6 text-center">
            <h2 className="text-4xl font-normal tracking-[-0.02em] text-foreground sm:text-5xl">
              Meet Agent Bounty
            </h2>
            <p className="text-lead text-muted-foreground">
              It reads every report, checks it against the target the server pins, and drafts the
              reply. What it never does is decide: the verdict comes from the oracle, and the
              words that go out are the ones you signed.
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
                  <SandboxDiagram targetName="juice-shop-v17.3.0" status={{}} />
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
              <QueuePanel />
            </Framed>
          }
        />

        <Feature
          eyebrow="Reports"
          title="Everything that arrived, however it ended"
          body="The board hides closed work on purpose, so the index is the list that hides nothing. Search across title, issue and repository, filter to what is open or what is waiting on you, and open any of them straight into its case file."
          visual={
            <Framed src="/backdrop/reports.webp">
              <ReportsPanel />
            </Framed>
          }
        />

        {/* FAQ */}
        <section
          id="faq"
          className="mx-auto grid w-full max-w-7xl scroll-mt-20 gap-10 px-6 py-24 lg:grid-cols-[320px_1fr]"
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

      <SiteFooter />
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
      <div className={`flex min-w-0 flex-col items-start ${reverse ? "lg:order-2" : ""}`}>
        {/* Mono and sentence case, in the accent, with a little air under it so it reads as a
            label above the heading rather than the first line of it. */}
        <span className="font-mono text-body text-brand-soft pb-2">{eyebrow}</span>
        <h2 className="text-3xl leading-[1.15] font-normal tracking-[-0.02em] text-foreground sm:text-4xl">
          {title}
        </h2>
        <p className="mt-7 max-w-[560px] text-lead text-muted-foreground">{body}</p>
      </div>
      <div className={`min-w-0 ${reverse ? "lg:order-1" : ""}`}>{visual}</div>
    </section>
  );
}

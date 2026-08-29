import Image from "next/image";
import Link from "next/link";
import { Check, Circle, Detective, Folder, Sparkle } from "@phosphor-icons/react/ssr";
import { Gmail, GitHubLight, OneDrive } from "developer-icons";

import { PhaseBadge } from "@/components/phase-dot";
import { RollingIcon } from "@/components/rolling-icon";
import { SandboxDiagram } from "@/components/sandbox-diagram";
import { SiteFooter } from "@/components/site-footer";
import { MascotMarquee } from "@/components/mascot-marquee";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { mascotStates } from "@/lib/mascot/states";

import { INTEGRATIONS, type IntegrationIcon } from "./(app)/integrations/catalog";
import { Faq } from "./faq";
import { ApprovalPanel, EvidencePanel, RecordPanel, SandboxList } from "./panels";

export const metadata = {
  title: "BountyDesk",
  description:
    "Automated bug-bounty triage: reproduce a report against a pinned target, ship a verdict only after a human approves the exact words.",
};

const SOURCE = "https://github.com/Vaibhav91one/bountydesk";

const CHANNEL_ICONS: Record<IntegrationIcon, React.ComponentType<{ className?: string }>> = {
  github: GitHubLight,
  gmail: Gmail,
  onedrive: OneDrive,
  folder: Folder,
};

/** The frozen MVP report lifecycle. Ten states, and the last five are terminal. */
const LIFECYCLE: { state: string; phase: string }[] = [
  { state: "Triaging", phase: "triaging" },
  { state: "Reproducing", phase: "reproducing" },
  { state: "Analysis only", phase: "analysis-only" },
  { state: "Awaiting approval", phase: "awaiting-approval" },
  { state: "Delivering", phase: "delivered" },
  { state: "Delivered", phase: "delivered" },
  { state: "Denied", phase: "closed" },
  { state: "Out of scope", phase: "closed" },
  { state: "Cancelled", phase: "closed" },
  { state: "Expired", phase: "closed" },
];

const BUILT = [
  "Signed GitHub App intake, deduplicated on the delivery id",
  "A durable jobs queue with leased workers and a sweeper",
  "The review queue, the reports index and the case file",
  "The approval gate, bound to the exact payload hash",
  "Sign-in behind a reviewer allowlist, re-checked every request",
  "An append-only record of verdicts, decisions, events and attempts",
];

const DESIGNED = [
  "The build and reproduction sandboxes",
  "The canary oracle and its negative control",
  "Comment delivery back to the issue",
  "Email and file-upload intake",
  "The dynamic per-repository target tier",
];

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
        <section className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-20">
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
        <section className="flex flex-col items-center gap-12 py-24">
          {/* w-full because the section centres its children, which otherwise shrink-wraps
              the track to its own 3584px content width: the edge mask then lands far outside
              the viewport and the fade never shows. */}
          <MascotMarquee
            states={mascotStates()}
            direction="horizontal"
            size={128}
            className="w-full"
          />

          <div className="flex max-w-2xl flex-col items-center gap-4 px-6 text-center">
            <h2 className="flex flex-wrap items-center justify-center gap-3 text-4xl font-normal tracking-[-0.02em] text-brand-soft sm:text-5xl">
              <Detective weight="fill" aria-hidden="true" className="size-9 sm:size-11" />
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
                  a scrolling finger gets stuck. The list says the same thing and scrolls. */}
              <div className="hidden md:block">
                <SandboxDiagram targetName="juice-shop-v17.3.0" status={{}} />
              </div>
              <div className="md:hidden">
                <SandboxList />
              </div>
            </>
          }
        />

        <Feature
          reverse
          eyebrow="Evidence"
          title="No fixture, no reproduced verdict"
          body="A target without a defender-authored fixture and oracle cannot return a reproduced verdict, whatever the proof of concept printed and whatever the model read out of a log. That run produces an analysis packet instead, and a human decides. It is the rule that does not move when the sandboxes ship."
          visual={<EvidencePanel />}
        />

        <Feature
          eyebrow="The gate"
          title="Nothing is ever auto-closed"
          body="The verdict is drafted, frozen, and posted only after a reviewer approves the exact words. The delivery worker reads the immutable verdict and refuses any payload whose hash differs from the approved one, so an approval cannot be reused for different text."
          visual={<RecordPanel />}
        />

        {/* The lifecycle, where the reference puts a demo video. There is no video, and this is
            the one thing a screenshot could not show anyway. */}
        <section className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-24">
          <div className="flex flex-col gap-3">
            <span className="text-label text-brand-soft uppercase">Lifecycle</span>
            <h2 className="text-title text-foreground">Ten states, and five of them are the end</h2>
            <p className="max-w-2xl text-lead text-muted-foreground">
              The report lifecycle is frozen and separate from job execution, so a failed delivery
              is a worker retrying, not a state a reviewer has to read.
            </p>
          </div>
          <ul className="flex flex-wrap gap-2">
            {LIFECYCLE.map((entry) => (
              <li key={entry.state}>
                <PhaseBadge phase={entry.phase}>{entry.state}</PhaseBadge>
              </li>
            ))}
          </ul>
        </section>

        {/* What runs today */}
        <section id="status" className="mx-auto w-full max-w-6xl scroll-mt-20 px-6 py-24">
          <div className="flex flex-col gap-8 rounded-xl border border-border/50 bg-card p-8">
            <div className="flex flex-col gap-3">
              <span className="text-label text-brand-soft uppercase">Status</span>
              <h2 className="text-title text-foreground">What runs today</h2>
              <p className="max-w-2xl text-lead text-muted-foreground">
                This product refuses to post a comment nobody read. It would be a poor front door
                for it to overstate what it does.
              </p>
            </div>

            <div className="grid gap-8 sm:grid-cols-2">
              <div className="flex flex-col gap-3">
                <h3 className="text-heading text-foreground">Built</h3>
                <ul className="flex flex-col gap-2.5">
                  {BUILT.map((item) => (
                    <li key={item} className="flex items-start gap-2.5">
                      <Check
                        weight="bold"
                        aria-hidden="true"
                        className="mt-1 size-3.5 shrink-0 text-phase-delivered"
                      />
                      <span className="text-body text-muted-foreground">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex flex-col gap-3">
                <h3 className="text-heading text-foreground">Coming soon</h3>
                <ul className="flex flex-col gap-2.5">
                  {DESIGNED.map((item) => (
                    <li key={item} className="flex items-start gap-2.5">
                      <Circle
                        aria-hidden="true"
                        className="mt-1 size-3.5 shrink-0 text-muted-foreground/60"
                      />
                      <span className="text-body text-muted-foreground">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section
          id="faq"
          className="mx-auto grid w-full max-w-6xl scroll-mt-20 gap-10 px-6 py-24 lg:grid-cols-[320px_1fr]"
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
    <section className="mx-auto grid w-full max-w-6xl items-center gap-10 px-6 py-20 lg:grid-cols-2 lg:gap-16 lg:py-24">
      <div className={`flex min-w-0 flex-col items-start gap-4 ${reverse ? "lg:order-2" : ""}`}>
        <span className="text-label text-brand-soft uppercase">{eyebrow}</span>
        <h2 className="text-title text-foreground">{title}</h2>
        <p className="max-w-[560px] text-lead text-muted-foreground">{body}</p>
      </div>
      <div className={`min-w-0 ${reverse ? "lg:order-1" : ""}`}>{visual}</div>
    </section>
  );
}

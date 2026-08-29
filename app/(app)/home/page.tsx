import Link from "next/link";
import { Gmail, GitHubLight, OneDrive } from "developer-icons";
import { ArrowRight, ArrowSquareOut, Check, CheckCircle, Envelope, Folder, Plus, Signature, Target, UploadSimple } from "@phosphor-icons/react/ssr";

import { Badge } from "@/components/ui/badge";
import { RollingIcon } from "@/components/rolling-icon";
import { Button } from "@/components/ui/button";
import { requireReviewer } from "@/lib/auth/dal";
import { installUrl } from "@/lib/auth/oauth";
import { listConnections } from "@/lib/github/connections";
import { mascotState } from "@/lib/mascot/states";

export const metadata = { title: "Home · BountyDesk" };

/**
 * Report sources, in the order they are likely to matter.
 *
 * `state` is what is true today, not what is planned: GitHub is the only one wired, email and
 * upload are designed channels with no route yet, and a drive connector is not in the product
 * at all. developer-icons carries no Google Drive, so OneDrive stands in for the brand, and a
 * folder is not a brand at all so it comes from Phosphor.
 */
const INTEGRATIONS = [
  { key: "github", name: "GitHub", icon: GitHubLight, state: "not connected" },
  { key: "drive", name: "Drive", icon: OneDrive, state: "not planned" },
  { key: "email", name: "Email", icon: Gmail, state: "designed, not built" },
  { key: "upload", name: "File upload", icon: Folder, state: "designed, not built" },
] as const;

/** A setup card. `done` is read from the database, never assumed. */
function SetupCard({
  icon,
  title,
  body,
  done,
  action,
  note,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  done?: string;
  action?: React.ReactNode;
  note?: string;
}) {
  return (
    <section className="flex flex-col gap-3.5 rounded-xl border border-border/50 bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="flex size-10 items-center justify-center rounded-lg border bg-background">
          {icon}
        </span>
        {done ? (
          <Badge variant="outline" className="gap-1 text-brand-soft">
            <CheckCircle className="size-3" />
            {done}
          </Badge>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <h2 className="text-heading text-foreground">{title}</h2>
        <p className="text-body text-muted-foreground">{body}</p>
      </div>

      <div className="mt-auto flex flex-col gap-2">
        {action}
        {note ? <p className="text-meta text-muted-foreground">{note}</p> : null}
      </div>
    </section>
  );
}

export default async function HomePage() {
  await requireReviewer();
  const mascot = mascotState("idle");
  const connections = await listConnections();

  const live = connections.filter((c) => !c.suspendedAt);
  const repositories = live.flatMap((c) => c.repositories);
  const admissible = repositories.filter((r) => r.status === "admissible");

  return (
    <main className="flex flex-1 flex-col gap-8 p-8">
      <header className="flex items-center gap-4">
        {/* Inlined rather than an <img>: the animation lives in a <style> block inside the
            file and an image does not reliably run it. The site preloader carries its own copy
            under a different id prefix, so the two can sit on the page together. */}
        <span
          aria-hidden="true"
          className="size-24 shrink-0 [&>svg]:block [&>svg]:size-full"
          dangerouslySetInnerHTML={{ __html: mascot.markup }}
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

        <SetupCard
          icon={<Target className="size-5" />}
          title="Reproduction target"
          body="A report can only be reproduced against a server-held target profile: a pinned image, its digest, and a defender-authored fixture. Without one a report stops at analysis only."
          done={admissible.length > 0 ? `${admissible.length} bound` : undefined}
          action={
            <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/integrations" />}>
              Bind a target <RollingIcon icon={ArrowRight} className="size-3.5" />
            </Button>
          }
          note={
            admissible.length === 0
              ? "Nothing is bound yet, so intake refuses every repository."
              : undefined
          }
        />

        <SetupCard
          icon={<Signature className="size-5" />}
          title="Human approval"
          body="Nothing is ever auto-closed. The verdict is drafted, frozen, and posted only after a reviewer approves the exact words, and the tool refuses any payload whose hash moved."
          done="Always on"
          note="Not a setting. It is how delivery works."
        />
      </div>

      <section className="flex flex-col gap-4 rounded-xl border border-border/50 border-l-2 border-l-brand/60 bg-card/40 px-6 py-5">
        <h2 className="text-label text-muted-foreground uppercase">
          What is built so far
        </h2>
        <ul className="flex flex-col gap-3 text-body">
          {[
            { text: "GitHub App intake with signature checks and durable, idempotent delivery", href: "/integrations", link: "Open integrations" },
            { text: "Separate job execution and report lifecycle state machines, with leased workers", href: null, link: null },
            { text: "Scope bound at the capability boundary, never from a string the agent produced", href: null, link: null },
            { text: "Sign-in restricted to a reviewer allowlist, re-checked on every request", href: null, link: null },
          ].map((row) => (
            <li key={row.text} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-foreground">{row.text}</span>
              {row.href ? (
                <Link href={row.href} className="inline-flex items-center gap-1 text-brand-soft">
                  <ArrowRight className="size-3.5" />
                  {row.link}
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-label text-muted-foreground uppercase">
          Channels that need no GitHub connection
        </h2>
        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-meta text-muted-foreground">
            <Envelope className="size-4" /> Email intake
            <Badge variant="outline" className="text-muted-foreground">designed</Badge>
          </span>
          <span className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-meta text-muted-foreground">
            <UploadSimple className="size-4" /> File upload
            <Badge variant="outline" className="text-muted-foreground">designed</Badge>
          </span>
          <a
            href="https://github.com/Vaibhav91one/bountydesk"
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-meta text-muted-foreground hover:text-foreground"
          >
            Repository <ArrowSquareOut className="size-3.5" />
          </a>
        </div>
      </section>
    </main>
  );
}

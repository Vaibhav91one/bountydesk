import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Check, Prohibit, Signature, X } from "@phosphor-icons/react/ssr";

import { PhaseBadge } from "@/components/phase-dot";
import { RollingIcon } from "@/components/rolling-icon";
import { Button } from "@/components/ui/button";

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
const COMMIT = "1867b926";

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
          <span className="text-label text-muted-foreground uppercase">{label}</span>
          <span className="text-label text-muted-foreground/60 uppercase">Example</span>
        </div>
      ) : null}
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/50 py-2.5 last:border-b-0">
      <span className="text-meta text-muted-foreground">{label}</span>
      <span className="min-w-0 text-meta text-foreground">{children}</span>
    </div>
  );
}

/** The hero panel: the moment the whole product exists for. */
export function ApprovalPanel() {
  return (
    <Panel label="Sign the verdict" header={false}>
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <PhaseBadge phase="awaiting-approval">Awaiting approval</PhaseBadge>
          <span className="min-w-0 truncate text-body font-medium text-foreground">
            Auth bypass via SQL injection on login
          </span>
        </div>

        <div className="flex flex-col gap-2.5 rounded-md border border-border/50 bg-background p-4">
          <span className="text-meta text-muted-foreground">Agent Bounty drafted this reply</span>
          <p className="text-body text-foreground">
            <strong className="font-medium">Verdict: analysis only.</strong> BountyDesk could not
            reproduce this report automatically, so no reproduced verdict was produced. A reviewer
            read the report and the run&rsquo;s own event log and is signing this reply by hand.
          </p>
          <span className="flex items-center gap-2 text-body text-muted-foreground">
            <Image src="/logo-small.svg" alt="" width={16} height={16} />
            Signed via BountyDesk.
          </span>
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
          <span className="text-meta text-muted-foreground">Analysis only, nothing ran</span>
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
          <Button size="sm" nativeButton={false} render={<Link href="/login" />}>
            <RollingIcon icon={Signature} weight="fill" className="size-4" /> Approve
          </Button>
        </span>
      </div>
    </Panel>
  );
}

/** Intake: a delivery arrives, is checked, and is written down once. */
export function IntakePanel() {
  const rows = [
    { id: "8f2c…", note: "Signature verified", state: "accepted" },
    { id: "8f2c…", note: "Same delivery id, replayed", state: "no-op" },
    { id: "b41a…", note: "Signature failed", state: "refused" },
  ];

  return (
    <Panel label="Webhook deliveries">
      <ul className="flex flex-col px-5 py-2">
        {rows.map((row, index) => (
          <li
            key={index}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border/50 py-3 last:border-b-0"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              {row.state === "refused" ? (
                <X weight="bold" aria-hidden="true" className="size-3.5 text-destructive" />
              ) : (
                <Check
                  weight="bold"
                  aria-hidden="true"
                  className="size-3.5 text-phase-delivered"
                />
              )}
              <span className="font-mono text-meta text-foreground">{row.id}</span>
              <span className="truncate text-meta text-muted-foreground">{row.note}</span>
            </span>
            <span className="shrink-0 text-meta text-muted-foreground">{row.state}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Scope: what the guard holds, and what it refuses. */
export function ScopePanel() {
  return (
    <Panel label="Authorised target">
      <div className="flex flex-col px-5 py-2">
        <Row label="Profile">{TARGET}</Row>
        <Row label="Commit">
          <span className="font-mono">{COMMIT}</span>
        </Row>
        <Row label="Image digest">
          <span className="font-mono break-all">sha256:9f31c0…</span>
        </Row>
      </div>

      <div className="flex flex-col gap-2 border-t border-border/50 px-5 py-4">
        <span className="flex items-start gap-2.5 text-meta">
          <Check weight="bold" aria-hidden="true" className="mt-1 size-3.5 shrink-0 text-phase-delivered" />
          <span className="text-muted-foreground">
            Clone, deploy and egress each read the target from this profile.
          </span>
        </span>
        <span className="flex items-start gap-2.5 text-meta">
          <X weight="bold" aria-hidden="true" className="mt-1 size-3.5 shrink-0 text-destructive" />
          <span className="text-muted-foreground">
            A host named in the report, or by the model, is refused.
          </span>
        </span>
      </div>
    </Panel>
  );
}

/** The evidence packet a report gets when reproduction cannot run. */
export function EvidencePanel() {
  return (
    <Panel label="Evidence packet">
      <div className="flex flex-col gap-3 p-5">
        <PhaseBadge phase="analysis-only" className="self-start">
          Analysis only
        </PhaseBadge>
        <p className="text-body text-muted-foreground">
          No canary was seeded, no negative control ran and no oracle was consulted, so there is
          no evidence to weigh and nothing claims otherwise.
        </p>
        <div className="rounded-md border border-border/50 bg-background p-3">
          <code className="font-mono text-meta break-all text-foreground">
            {`{ "reason": "AUTOMATED_REPRODUCTION_NOT_RUN" }`}
          </code>
        </div>
      </div>
    </Panel>
  );
}

/** The record: four tables the database will not let anybody edit. */
export function RecordPanel() {
  const rows = [
    "verdict",
    "approval_decision",
    "session_event",
    "delivery_attempt",
  ];

  return (
    <Panel label="Append only">
      <ul className="flex flex-col px-5 py-2">
        {rows.map((table) => (
          <li
            key={table}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border/50 py-3 last:border-b-0"
          >
            <span className="font-mono text-meta text-foreground">{table}</span>
            <span className="text-meta text-muted-foreground">UPDATE and DELETE refused</span>
          </li>
        ))}
      </ul>
      <p className="border-t border-border/50 px-5 py-4 text-meta text-muted-foreground">
        Enforced by database triggers, not by application code that could be talked out of it. A
        verdict is revised by inserting the next revision.
      </p>
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
          <span className="font-mono text-meta text-muted-foreground">{index + 1}</span>
          <span className="min-w-0 flex-1 truncate text-body text-foreground">{stage.title}</span>
          <span className="shrink-0 text-meta text-muted-foreground">{stage.kind}</span>
          {index < stages.length - 1 ? (
            <ArrowRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground/50" />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

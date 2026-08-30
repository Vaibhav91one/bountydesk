import { Docker, GitHubLight, NextJs } from "developer-icons";
import { ArrowRight, Check } from "@phosphor-icons/react/ssr";

import { cn } from "@/lib/utils";

/**
 * The stages this report's run actually went through, on the agent-authored path.
 *
 * Three nodes, because three are real: the connected repository resolved to a commit, the
 * trusted controller (BountyDesk) processed the report, and the target ran only if a sandbox
 * was provisioned for it. A node is ticked from what the database can show, never from a stage
 * this path does not run. The deterministic canary pipeline (an untrusted build sandbox, a PoC
 * runner and an external oracle) is retained but does not run here (docs/decisions.md Q22); it
 * is named in the footnote rather than drawn as a pending stage, because a node that never runs
 * on this path reads as one still to come.
 */

type NodeTone = "triaging" | "reproducing";

/**
 * The pill above each node: the phase colour as ink on a dark mix of itself. Written out rather
 * than built from the tone key, because Tailwind reads source for literal class names and a
 * template would compile to nothing.
 */
const TONE: Record<NodeTone, string> = {
  triaging: "bg-phase-triaging/15 text-phase-triaging",
  reproducing: "bg-phase-reproducing/15 text-phase-reproducing",
};

function Node({
  kind,
  title,
  subtitle,
  icon,
  tone,
  done,
}: {
  kind: string;
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  tone: NodeTone;
  /** A tick when the stage happened; nothing when it did not, so an unrun stage never wears a
   * mark it did not earn. */
  done: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="text-[11px] leading-none font-medium">
        <span className={cn("inline-block rounded-md px-2 py-1", TONE[tone])}>{kind}</span>
      </span>
      <div className="flex items-center gap-2.5 rounded-xl border border-border/50 bg-card p-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background">
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-medium text-foreground">{title}</span>
          {subtitle ? (
            <span className="truncate font-mono text-meta text-muted-foreground">{subtitle}</span>
          ) : null}
        </span>
        {done ? (
          <Check
            weight="bold"
            aria-hidden="true"
            className="size-3.5 shrink-0 text-phase-delivered"
          />
        ) : null}
      </div>
    </div>
  );
}

/** The chevron between two nodes. Points down when stacked, right when in a row. */
function Connector() {
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center self-center text-muted-foreground"
    >
      <ArrowRight className="hidden size-4 sm:block" />
      <ArrowRight className="size-4 rotate-90 sm:hidden" />
    </span>
  );
}

export function SandboxDiagram({
  repositoryFullName,
  targetName,
  sandboxId,
}: {
  repositoryFullName: string | null;
  targetName: string | null;
  /** The provisioned sandbox this run used, if any. Its presence is what makes the target node
   * real: no sandbox id, no target ran. */
  sandboxId: string | null;
}) {
  const targetTitle = targetName ?? "No target bound";
  // The target ran only if a sandbox was provisioned for it. A bound target with no sandbox is
  // a report that stopped at analysis only, so the node stays unticked.
  const targetRan = sandboxId !== null;

  return (
    <div
      className="flex flex-col gap-4 rounded-xl border border-border/50 bg-background p-5"
      style={{
        backgroundImage: "radial-gradient(var(--border) 1px, transparent 1.25px)",
        backgroundSize: "22px 22px",
        backgroundPosition: "center",
      }}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <Node
          kind="Connected repo"
          title={repositoryFullName ?? "No repository"}
          subtitle="Pinned commit"
          icon={<GitHubLight className="size-4" />}
          tone="triaging"
          done={repositoryFullName !== null}
        />
        <Connector />
        <Node
          kind="Trusted controller"
          title="BountyDesk"
          icon={<NextJs className="size-4" />}
          tone="triaging"
          done
        />
        <Connector />
        <Node
          kind="Target runtime"
          title={targetTitle}
          subtitle={sandboxId ?? "Not provisioned"}
          icon={<Docker className="size-4" />}
          tone="reproducing"
          done={targetRan}
        />
      </div>

      <p className="text-meta text-muted-foreground">
        The deterministic canary pipeline (an untrusted build sandbox, a PoC runner and an
        external oracle) is retained but does not run on the agent-authored path
        (docs/decisions.md Q22).
      </p>
    </div>
  );
}

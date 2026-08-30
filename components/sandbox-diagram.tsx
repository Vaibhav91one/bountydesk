"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Docker, GitHubLight, NextJs } from "developer-icons";
import { Check } from "@phosphor-icons/react/ssr";

import { cn } from "@/lib/utils";

/**
 * The stages this report's run actually went through, on the agent-authored path, drawn as a
 * top-to-bottom flowchart.
 *
 * Three nodes, because three are real: the connected repository resolved to a commit, the
 * trusted controller (BountyDesk) processed the report, and the target ran only if a sandbox
 * was provisioned for it. A node is ticked from what the database can show, never from a stage
 * this path does not run. The deterministic canary pipeline (an untrusted build sandbox, a PoC
 * runner and an external oracle) is retained but does not run here (docs/decisions.md Q22), so
 * it is not drawn: a node that never runs on this path reads as one still to come.
 */

type NodeTone = "triaging" | "reproducing";

/**
 * The pill above each node and its icon-tile hue, keyed by phase. Written out rather than built
 * from the tone key, because Tailwind reads source for literal class names and a template would
 * compile to nothing. The hue is the phase's own CSS variable, mixed for the tile so the panel
 * stays on the app's tokens in both themes instead of raw hex.
 */
const TONE: Record<NodeTone, { pill: string; hue: string }> = {
  triaging: { pill: "bg-phase-triaging/15 text-phase-triaging", hue: "var(--phase-triaging)" },
  reproducing: {
    pill: "bg-phase-reproducing/15 text-phase-reproducing",
    hue: "var(--phase-reproducing)",
  },
};

type FlowNode = {
  kind: string;
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  tone: NodeTone;
  /** A tick when the stage happened; nothing when it did not, so an unrun stage never wears a
   * mark it did not earn. */
  done: boolean;
};

// The connector: a bezier from one card's measured bottom-centre to the next card's measured
// top-centre. Cards sit at their center x, so a straight vertical stack draws a clean vertical
// drop; the curve only bends if a card is ever off-centre. k pulls the control points along the
// gap so the join stays smooth however tall the gap is.
function bezier(from: { x: number; y: number }, to: { x: number; y: number }) {
  const k = Math.min(Math.max(Math.abs(to.y - from.y) * 0.55, 24), 84);
  return `M ${from.x} ${from.y} C ${from.x} ${from.y + k}, ${to.x} ${to.y - k}, ${to.x} ${to.y}`;
}

function NodeCard({ node, cardRef }: { node: FlowNode; cardRef: (el: HTMLDivElement | null) => void }) {
  const { hue, pill } = TONE[node.tone];
  return (
    <div className="flex w-full max-w-[340px] flex-col gap-2">
      <span className="text-[11px] leading-none font-medium">
        <span className={cn("inline-block rounded-md px-2 py-1", pill)}>{node.kind}</span>
      </span>
      <div
        ref={cardRef}
        className="flex items-center gap-2.5 rounded-xl border border-border/50 bg-card p-3 shadow-sm"
      >
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-[8px]"
          style={{
            color: hue,
            background: `color-mix(in oklch, ${hue} 12%, var(--card))`,
            boxShadow: `0 0 0 1px color-mix(in oklch, ${hue} 20%, transparent)`,
          }}
        >
          {node.icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-medium text-foreground">{node.title}</span>
          {node.subtitle ? (
            <span className="truncate font-mono text-meta text-muted-foreground">
              {node.subtitle}
            </span>
          ) : null}
        </span>
        {node.done ? (
          <Check weight="bold" aria-hidden="true" className="size-3.5 shrink-0 text-phase-delivered" />
        ) : null}
      </div>
    </div>
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

  const nodes: FlowNode[] = [
    {
      kind: "Connected repo",
      title: repositoryFullName ?? "No repository",
      subtitle: "Pinned commit",
      icon: <GitHubLight className="size-4" />,
      tone: "triaging",
      done: repositoryFullName !== null,
    },
    {
      kind: "Trusted controller",
      title: "BountyDesk",
      icon: <NextJs className="size-4" />,
      tone: "triaging",
      done: true,
    },
    {
      kind: "Target runtime",
      title: targetTitle,
      subtitle: sandboxId ?? "Not provisioned",
      icon: <Docker className="size-4" />,
      tone: "reproducing",
      done: targetRan,
    },
  ];

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [edges, setEdges] = useState<{ d: string; lit: boolean }[]>([]);

  // Measure the real card rects relative to the canvas and rebuild the connectors from them, so
  // the vertical layout is exact rather than estimated. Runs after layout and again on any size
  // change (font swap, theme, container resize) through the ResizeObserver below.
  const measure = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const base = canvas.getBoundingClientRect();
    const anchors = cardRefs.current.map((el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cx = r.left - base.left + r.width / 2;
      return { top: { x: cx, y: r.top - base.top }, bottom: { x: cx, y: r.bottom - base.top } };
    });
    const next: { d: string; lit: boolean }[] = [];
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i];
      const b = anchors[i + 1];
      if (!a || !b) continue;
      // Light the edge once its downstream stage has actually run, so the drawn flow tracks how
      // far this report got rather than the shape it could take.
      next.push({ d: bezier(a.bottom, b.top), lit: nodes[i + 1].done });
    }
    setEdges(next);
    // nodes is rebuilt each render from props; measure only reads the .done booleans off it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repositoryFullName, targetName, sandboxId]);

  useLayoutEffect(() => {
    measure();
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    for (const el of cardRefs.current) {
      if (el) ro.observe(el);
    }
    return () => ro.disconnect();
  }, [measure]);

  return (
    <div
      ref={canvasRef}
      className="relative flex flex-col items-center gap-16 overflow-hidden rounded-xl border border-border/50 bg-background p-6"
      style={{
        backgroundImage: "radial-gradient(var(--border) 1px, transparent 1.25px)",
        backgroundSize: "22px 22px",
        backgroundPosition: "center",
      }}
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
      >
        {edges.map((edge, i) => (
          <path
            key={i}
            d={edge.d}
            fill="none"
            strokeWidth={1.5}
            stroke={edge.lit ? "var(--phase-delivered)" : "var(--border)"}
          />
        ))}
      </svg>

      {nodes.map((node, i) => (
        <div key={node.kind} className="relative z-10 flex w-full justify-center">
          <NodeCard
            node={node}
            cardRef={(el) => {
              cardRefs.current[i] = el;
            }}
          />
        </div>
      ))}
    </div>
  );
}

"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Docker, GitHubLight } from "developer-icons";
import { Check, Cube, Robot, SealCheck, ShieldCheck } from "@phosphor-icons/react/ssr";

import { onboardingStepDone } from "@/app/(app)/connections/onboarding-steps";

/**
 * How a repository becomes a reproduction target, drawn as a top-to-bottom flowchart: the
 * agent-orchestrated onboarding pipeline. The connected repo is classified and reviewed for
 * sandboxability, a build agent builds the image(s) in a DinD sandbox, the driver pins a snapshot
 * and derives the manifest, a human approves, the snapshot is verified offline with no egress, and
 * the target profile is written. Each node is ticked from the current onboarding state, so the
 * drawing tracks how far a repo has actually got.
 *
 * The bezier / ResizeObserver measuring machinery is a focused copy of components/sandbox-diagram.tsx.
 * ponytail: duplicated ~70 lines of chart layout; extract a shared FlowChart if a third diagram appears.
 */

type FlowNode = {
  kind: string;
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  /** The node's hue, a phase CSS variable, used for the pill and the icon tile in both themes. */
  hue: string;
  done: boolean;
};

function bezier(from: { x: number; y: number }, to: { x: number; y: number }) {
  const k = Math.min(Math.max(Math.abs(to.y - from.y) * 0.55, 24), 84);
  return `M ${from.x} ${from.y} C ${from.x} ${from.y + k}, ${to.x} ${to.y - k}, ${to.x} ${to.y}`;
}

function NodeCard({ node, cardRef }: { node: FlowNode; cardRef: (el: HTMLDivElement | null) => void }) {
  return (
    <div className="flex w-full max-w-[340px] flex-col gap-2">
      <span className="text-[11px] leading-none font-medium">
        <span
          className="inline-block rounded-md px-2 py-1"
          style={{ color: node.hue, background: `color-mix(in oklch, ${node.hue} 15%, transparent)` }}
        >
          {node.kind}
        </span>
      </span>
      <div className="flex items-center gap-2.5 rounded-xl border border-border/50 bg-card p-3 shadow-sm" ref={cardRef}>
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-[8px]"
          style={{
            color: node.hue,
            background: `color-mix(in oklch, ${node.hue} 12%, var(--card))`,
            boxShadow: `0 0 0 1px color-mix(in oklch, ${node.hue} 20%, transparent)`,
          }}
        >
          {node.icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-medium text-foreground">{node.title}</span>
          {node.subtitle ? (
            <span className="truncate text-meta text-muted-foreground">{node.subtitle}</span>
          ) : null}
        </span>
        {node.done ? (
          <Check weight="bold" aria-hidden="true" className="size-3.5 shrink-0 text-phase-delivered" />
        ) : null}
      </div>
    </div>
  );
}

export function OnboardingDiagram({
  repositoryFullName,
  state,
}: {
  repositoryFullName: string | null;
  state: string | null;
}) {
  const done = (key: string) => onboardingStepDone(state, key);

  const nodes: FlowNode[] = [
    {
      kind: "Connected repo",
      title: repositoryFullName ?? "No repository",
      subtitle: "Cloned in a build sandbox at a pinned commit",
      icon: <GitHubLight className="size-4" />,
      hue: "var(--phase-triaging)",
      done: repositoryFullName !== null,
    },
    {
      kind: "Classify & review",
      title: "Onboarding agent",
      subtitle: "Decides whether the repo can be sandboxed",
      icon: <ShieldCheck className="size-4" weight="fill" />,
      hue: "var(--phase-triaging)",
      done: done("plan"),
    },
    {
      kind: "Build",
      title: "Build agent",
      subtitle: "Builds the target image in a DinD sandbox",
      icon: <Robot className="size-4" weight="fill" />,
      hue: "var(--phase-reproducing)",
      done: done("build"),
    },
    {
      kind: "Snapshot & manifest",
      title: "Build driver",
      subtitle: "Pins a snapshot and derives the target manifest",
      icon: <Cube className="size-4" weight="fill" />,
      hue: "var(--phase-reproducing)",
      done: done("manifest"),
    },
    {
      kind: "Approval",
      title: "Human reviewer",
      subtitle: "Approves the exact build, name and digest",
      icon: <ShieldCheck className="size-4" weight="fill" />,
      hue: "var(--phase-approval)",
      done: done("approval"),
    },
    {
      kind: "Verify",
      title: "Offline verify",
      subtitle: "Boots the snapshot with no egress",
      icon: <Docker className="size-4" />,
      hue: "var(--phase-reproducing)",
      done: done("verify"),
    },
    {
      kind: "Configured target",
      title: "Reproduction target",
      subtitle: "Written server-side and bound to the repo",
      icon: <SealCheck className="size-4" weight="fill" />,
      hue: "var(--phase-delivered)",
      done: done("configured"),
    },
  ];

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [edges, setEdges] = useState<{ d: string; lit: boolean }[]>([]);

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
      next.push({ d: bezier(a.bottom, b.top), lit: nodes[i + 1].done });
    }
    setEdges(next);
    // nodes is rebuilt each render from props; measure only reads the .done booleans off it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repositoryFullName, state]);

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
      className="relative flex flex-col items-center gap-12 overflow-hidden rounded-xl border border-border/50 bg-background p-6"
      style={{
        backgroundImage: "radial-gradient(var(--border) 1px, transparent 1.25px)",
        backgroundSize: "22px 22px",
        backgroundPosition: "center",
      }}
    >
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
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

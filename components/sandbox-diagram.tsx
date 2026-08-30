"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Docker, GitHubLight, NextJs } from "developer-icons";
import { Check, CircleNotch, MagnifyingGlass, Terminal } from "@phosphor-icons/react/ssr";

import { cn } from "@/lib/utils";

/**
 * The sandbox topology, on a canvas you can rearrange.
 *
 * This is an architecture diagram, not a record of a run. Nothing here has executed: the
 * sandbox is designed and not built, so the nodes describe the shape reproduction will take
 * and the canvas says so in as many words. No canary result, no resource use, no readiness
 * state, because there is no run to read them from.
 *
 * Ported from a flowchart canvas that carried its own token system. The mechanics are the
 * part worth keeping, so they are: a dotted ground, node positions measured rather than
 * assumed, and connectors drawn between measured anchors so they stay attached while a card
 * moves. Everything visual is on this product's tokens instead of a second palette.
 */

type Node = {
  id: string;
  /** Where the node sits, as a fraction of the canvas. */
  x: number;
  y: number;
  kind: string;
  title: string;
  icon: React.ReactNode;
  /** Ties the node to a phase colour, so the diagram reads like the rest of the console. */
  tone: "triaging" | "reproducing" | "analysis" | "delivered";
};

/**
 * The pill above each node: the phase colour as ink, on a dark mix of itself as ground.
 *
 * Written out rather than built from the tone key, because Tailwind reads source for literal
 * class names and a template would compile to nothing.
 */
const TONE: Record<Node["tone"], string> = {
  triaging: "bg-phase-triaging/15 text-phase-triaging",
  reproducing: "bg-phase-reproducing/15 text-phase-reproducing",
  analysis: "bg-phase-analysis/15 text-phase-analysis",
  delivered: "bg-phase-delivered/15 text-phase-delivered",
};

/**
 * Whether a stage has happened, is happening, or has not.
 *
 * The page works these out from the report, and every one of them has to be something the
 * database can show. A tick on the oracle would say a canary was observed, which is the claim
 * this product must never make without an oracle having made it.
 */
export type NodeStatus = "done" | "running" | "idle";

/**
 * The dynamic tier, as the board draws it: connected repo, controller resolves an exact
 * commit, untrusted build sandbox builds it, the immutable result boots offline, an approved
 * plan runs against it, and an oracle outside that environment decides.
 *
 * The last edge goes back to the controller, because the oracle reports to it rather than to
 * the sandbox. That return is the whole point of the shape.
 */
const EDGES: [string, string][] = [
  ["repo", "controller"],
  ["controller", "build"],
  ["build", "target"],
  ["target", "poc"],
  ["poc", "oracle"],
  ["oracle", "controller"],
];

const CARD_WIDTH = 210;

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

/** Estimated for the first paint, replaced by measurement immediately after. */
const ESTIMATED_HEIGHT = 74;

export function SandboxDiagram({
  targetName,
  status,
}: {
  targetName: string | null;
  /** Per node, worked out by the page from what the report can actually show. */
  status: Record<string, NodeStatus>;
}) {
  const nodes: Node[] = [
    {
      id: "repo",
      x: 0.03,
      y: 0.04,
      kind: "Connected repo",
      title: "Exact commit",
      icon: <GitHubLight className="size-4" />,
      tone: "triaging",
    },
    {
      id: "controller",
      x: 0.53,
      y: 0.04,
      kind: "Trusted controller",
      title: "BountyDesk",
      icon: <NextJs className="size-4" />,
      tone: "triaging",
    },
    {
      id: "build",
      x: 0.03,
      y: 0.36,
      kind: "Untrusted build",
      title: "Build sandbox",
      icon: <Docker className="size-4" />,
      tone: "reproducing",
    },
    {
      id: "target",
      x: 0.53,
      y: 0.36,
      kind: "Target runtime",
      // The one node with something real behind it: the target this report is bound to.
      title: targetName ?? "no target bound",
      icon: <Docker className="size-4" />,
      tone: "reproducing",
    },
    {
      id: "poc",
      x: 0.03,
      y: 0.68,
      kind: "PoC runner",
      title: "Approved plan",
      icon: <Terminal className="size-4" />,
      tone: "analysis",
    },
    {
      id: "oracle",
      x: 0.53,
      y: 0.68,
      kind: "External oracle",
      title: "Canary check",
      icon: <MagnifyingGlass className="size-4" />,
      tone: "delivered",
    },
  ];

  const canvasRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [moved, setMoved] = useState<Record<string, { dx: number; dy: number }>>({});
  const drag = useRef<{ id: string; x: number; y: number; dx: number; dy: number } | null>(null);
  // The ref carries the drag maths, which only ever runs in handlers. Which card is on top is
  // a render decision, so it has to be state: reading the ref here would be reading a value
  // React has no reason to re-render for.
  const [dragging, setDragging] = useState<string | null>(null);

  // Measured rather than assumed: a caption that wraps to a second line moves the anchor a
  // connector has to end at, and a hard-coded height would leave the line short of the card.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const measure = () => {
      setSize({ w: canvas.clientWidth, h: canvas.clientHeight });
      setHeights((previous) => {
        const next = { ...previous };
        let changed = false;
        nodeRefs.current.forEach((el, id) => {
          const h = el.offsetHeight;
          if (h && Math.abs(h - (next[id] ?? 0)) > 0.5) {
            next[id] = h;
            changed = true;
          }
        });
        return changed ? next : previous;
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    nodeRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  const width = size.w || 640;
  const height = size.h || 340;
  const cardWidth = Math.min(CARD_WIDTH, width * 0.42);

  function place(node: Node) {
    const offset = moved[node.id];
    const h = heights[node.id] ?? ESTIMATED_HEIGHT;
    // The label sits above the card, so a node needs headroom as well as its own height.
    const LABEL = 22;
    return {
      left: clamp(node.x * width + (offset?.dx ?? 0), 8, width - cardWidth - 8),
      top: clamp(node.y * height + (offset?.dy ?? 0), 8, height - h - 8),
      height: h,
      labelHeight: LABEL,
    };
  }

  /**
   * A curve between the two edges that actually face each other.
   *
   * Always leaving by the right and arriving at the left looks right only while the flow runs
   * left to right. The moment a card is below or behind its predecessor, that pair of anchors
   * makes the line double back on itself, which is what the first version did between the
   * build sandbox and the one below it. Picking the axis by which gap is larger keeps the
   * connector short and pointing the way the flow goes, wherever a card is dragged.
   */
  function path(from: Node, to: Node) {
    const a = place(from);
    const b = place(to);
    const ax = a.left + cardWidth / 2;
    const ay = a.top + a.height / 2;
    const bx = b.left + cardWidth / 2;
    const by = b.top + b.height / 2;

    const horizontal = Math.abs(bx - ax) >= Math.abs(by - ay);
    const start = horizontal
      ? { x: bx > ax ? a.left + cardWidth : a.left, y: ay }
      : { x: ax, y: by > ay ? a.top + a.height : a.top };
    const end = horizontal
      ? { x: bx > ax ? b.left : b.left + cardWidth, y: by }
      : { x: bx, y: by > ay ? b.top : b.top + b.height };

    const span = horizontal ? Math.abs(end.x - start.x) : Math.abs(end.y - start.y);
    const bend = clamp(span * 0.5, 24, 90);

    return horizontal
      ? `M ${start.x} ${start.y} C ${start.x + (bx > ax ? bend : -bend)} ${start.y}, ${end.x - (bx > ax ? bend : -bend)} ${end.y}, ${end.x} ${end.y}`
      : `M ${start.x} ${start.y} C ${start.x} ${start.y + (by > ay ? bend : -bend)}, ${end.x} ${end.y - (by > ay ? bend : -bend)}, ${end.x} ${end.y}`;
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));

  function onPointerDown(node: Node) {
    return (event: React.PointerEvent<HTMLDivElement>) => {
      const offset = moved[node.id];
      drag.current = {
        id: node.id,
        x: event.clientX,
        y: event.clientY,
        dx: offset?.dx ?? 0,
        dy: offset?.dy ?? 0,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(node.id);
    };
  }

  function onPointerMove(node: Node) {
    return (event: React.PointerEvent<HTMLDivElement>) => {
      const state = drag.current;
      if (!state || state.id !== node.id) return;

      // Clamped to the canvas: a card dragged past the edge would be unreachable, and the
      // connector would run off to a point nobody can see.
      const h = heights[node.id] ?? ESTIMATED_HEIGHT;
      const left = node.x * width + state.dx + event.clientX - state.x;
      const top = node.y * height + state.dy + event.clientY - state.y;
      const clampedLeft = clamp(left, 8, width - cardWidth - 8);
      const clampedTop = clamp(top, 8, height - h - 8);

      setMoved((current) => ({
        ...current,
        [node.id]: { dx: clampedLeft - node.x * width, dy: clampedTop - node.y * height },
      }));
    };
  }

  function onPointerUp() {
    drag.current = null;
    setDragging(null);
  }

  return (
    <div
      ref={canvasRef}
      className="relative h-[460px] w-full touch-none overflow-hidden rounded-xl border border-border/50 bg-background select-none"
      style={{
        backgroundImage: "radial-gradient(var(--border) 1px, transparent 1.25px)",
        backgroundSize: "22px 22px",
        backgroundPosition: "center",
      }}
    >
      <svg
        width={width}
        height={height}
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
      >
        {EDGES.map(([from, to]) => (
          <path
            key={`${from}-${to}`}
            d={path(byId.get(from)!, byId.get(to)!)}
            fill="none"
            stroke="var(--border)"
            strokeWidth="1.25"
          />
        ))}
      </svg>

      {nodes.map((node) => {
        const { left, top } = place(node);
        return (
          <div
            key={node.id}
            ref={(el) => {
              if (el) nodeRefs.current.set(node.id, el);
              else nodeRefs.current.delete(node.id);
            }}
            onPointerDown={onPointerDown(node)}
            onPointerMove={onPointerMove(node)}
            onPointerUp={onPointerUp}
            className="absolute flex cursor-grab flex-col gap-1.5 active:cursor-grabbing"
            style={{ left, top, width: cardWidth, zIndex: dragging === node.id ? 2 : 1 }}
          >
            <span className="text-[11px] leading-none font-medium tracking-normal">
              <span className={cn("inline-block rounded-md px-2 py-1", TONE[node.tone])}>
                {node.kind}
              </span>
            </span>
            <div className="flex items-center gap-2.5 rounded-xl border border-border/50 bg-card p-3">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background">
                {node.icon}
              </span>
              <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">
                {node.title}
              </span>
              {status[node.id] === "done" ? (
                <Check
                  weight="bold"
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-phase-delivered"
                />
              ) : status[node.id] === "running" ? (
                <CircleNotch
                  aria-hidden="true"
                  className="size-3.5 shrink-0 animate-spin text-phase-approval motion-reduce:animate-none"
                />
              ) : null}
            </div>
          </div>
        );
      })}

      <span className="absolute right-3 bottom-3 text-meta text-muted-foreground">
        Coming soon. Drag to rearrange.
      </span>
    </div>
  );
}

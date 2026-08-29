"use client";

import { useLayoutEffect, useRef, useState } from "react";

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
  caption: string;
  /** Ties the node to a phase colour, so the diagram reads like the rest of the console. */
  tone: "triaging" | "reproducing" | "delivered";
};

const TONE: Record<Node["tone"], { dot: string; pill: string }> = {
  triaging: { dot: "bg-phase-triaging", pill: "text-phase-triaging" },
  reproducing: { dot: "bg-phase-reproducing", pill: "text-phase-reproducing" },
  delivered: { dot: "bg-phase-delivered", pill: "text-phase-delivered" },
};

const EDGES: [string, string][] = [
  ["capability", "build"],
  ["build", "reproduction"],
  ["reproduction", "oracle"],
];

const CARD_WIDTH = 210;

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

/** Estimated for the first paint, replaced by measurement immediately after. */
const ESTIMATED_HEIGHT = 74;

export function SandboxDiagram({ targetName }: { targetName: string | null }) {
  const nodes: Node[] = [
    {
      id: "capability",
      x: 0.04,
      y: 0.06,
      kind: "Server-held",
      title: "Target capability",
      caption: "Repository and pinned snapshot",
      tone: "triaging",
    },
    {
      id: "build",
      x: 0.54,
      y: 0.06,
      kind: "Build sandbox",
      title: "Narrow egress",
      caption: "Runs the customer's code. Not trusted.",
      tone: "reproducing",
    },
    {
      id: "reproduction",
      x: 0.04,
      y: 0.56,
      kind: "Reproduction sandbox",
      // The one node with something real behind it: the target this report is bound to.
      title: targetName ?? "no target bound",
      caption: "Offline. Only the built artifact crosses in.",
      tone: "reproducing",
    },
    {
      id: "oracle",
      x: 0.54,
      y: 0.56,
      kind: "Outside the sandbox",
      title: "Canary oracle",
      caption: "Decides the verdict. The model never does.",
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
      className="relative h-[380px] w-full touch-none overflow-hidden rounded-xl border border-border/50 bg-background select-none"
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
            <span className="flex items-center gap-1.5 text-label uppercase">
              <span className={cn("size-1.5 shrink-0 rounded-full", TONE[node.tone].dot)} />
              <span className={cn("truncate", TONE[node.tone].pill)}>{node.kind}</span>
            </span>
            <div className="flex flex-col gap-1 rounded-xl border border-border/50 bg-card p-3">
              <span className="text-body font-medium text-foreground">{node.title}</span>
              <span className="text-meta text-muted-foreground">{node.caption}</span>
            </div>
          </div>
        );
      })}

      <span className="absolute right-3 bottom-3 text-meta text-muted-foreground">
        Designed, not built. Drag to rearrange.
      </span>
    </div>
  );
}

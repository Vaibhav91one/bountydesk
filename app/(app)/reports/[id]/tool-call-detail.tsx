"use client";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";

/**
 * The un-redacted arguments and result of one tool call, shown on hover over the step that names
 * it.
 *
 * It used to be an inline panel of its own, which pushed long JSON out past the edge of the page
 * and the approval dialog. A hover keeps the detail one interaction away from the lifecycle step
 * it belongs to, and bounds it: the popup has a fixed max size and scrolls inside itself, so
 * nothing a tool returned can widen the page again.
 *
 * The detail is read live from TrueForge (see lib/reports/tool-calls.ts), not from the durable
 * session_event trace, so it carries the arguments and the tool's result the trace is
 * deliberately kept clear of. Everything is rendered as text, never as HTML: the agent probes an
 * untrusted target and may have absorbed prompt-injection content, so its arguments and a tool's
 * response are shown, not interpreted.
 */

/** The serializable slice of a ToolCallDetail a step needs to render its hover. */
export type ToolCallView = {
  toolName: string;
  argumentsJson: string;
  result: string | null;
};

function pretty(argumentsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argumentsJson), null, 2);
  } catch {
    // Not valid JSON: show whatever the model actually sent rather than hiding it.
    return argumentsJson;
  }
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-meta text-muted-foreground">{label}</span>
      {/* whitespace-pre-wrap keeps the JSON indentation; break-words stops a long unbroken token
          from widening the popup past its max width. Text content only. */}
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2.5 py-2 font-mono text-[0.75rem] leading-relaxed text-foreground">
        {text}
      </pre>
    </div>
  );
}

export function ToolCallHover({
  detail,
  children,
}: {
  /** Null when no live detail matched this step; the row then renders plain, with no hover. */
  detail: ToolCallView | null | undefined;
  children: React.ReactNode;
}) {
  if (!detail) return <>{children}</>;

  return (
    <HoverCard>
      {/* Rendered as a button so the hover is reachable by keyboard focus, not pointer only.
          It carries the row's own layout, so the step looks unchanged until it is opened. */}
      <HoverCardTrigger
        render={
          <button
            type="button"
            className="flex w-full min-w-0 items-center gap-4 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        }
      >
        {children}
      </HoverCardTrigger>

      <HoverCardContent className="flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2.5">
        <span className="truncate font-mono text-meta font-medium text-foreground">
          {detail.toolName}
        </span>
        <Block label="Arguments" text={pretty(detail.argumentsJson)} />
        {detail.result !== null ? (
          <Block label="Result" text={detail.result} />
        ) : (
          <span className="text-meta text-muted-foreground">
            No result recorded for this call.
          </span>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

"use client";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import type { ToolCallView } from "@/lib/reports/tool-call-view";

/**
 * The arguments and result of one tool call, shown under the row that names it.
 *
 * Two sources, and a row carries detail whenever it has either.
 *   - `detail` is read live from TrueForge (see lib/reports/tool-calls.ts): the full arguments
 *     and the tool's own result, which the durable trace is deliberately kept clear of. It is
 *     there when the harness is reachable, which the Vercel tier is not.
 *   - `fallback` is the allowlisted argument preview the poller already mirrored into
 *     session_event. It carries no secret, and it is what the row shows when the live detail is
 *     out of reach, so detail is populated everywhere rather than only where TrueForge routes.
 *
 * Everything is rendered as text, never as HTML: the agent probes an untrusted target and may
 * have absorbed prompt-injection content, so its arguments and a tool's response are shown, not
 * interpreted.
 */

export type ToolCallFallback = { toolName: string; argsPreview: string };

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
          from widening the container past its max width. Text content only. */}
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2.5 py-2 font-mono text-[0.75rem] leading-relaxed text-foreground">
        {text}
      </pre>
    </div>
  );
}

/**
 * The tool name, arguments and result, as expandable content. Shared by the hover in the agent
 * trace and the accordion rows in the lifecycle sheet, so both surfaces show one tool call the
 * same way.
 */
export function ToolCallBlocks({
  detail,
  fallback,
}: {
  detail: ToolCallView | null | undefined;
  fallback?: ToolCallFallback | null;
}) {
  const toolName = detail?.toolName ?? fallback?.toolName ?? "tool call";
  // The live arguments win when present, because they are the full ones; otherwise the preview.
  const argumentsText = detail ? pretty(detail.argumentsJson) : (fallback?.argsPreview ?? "");

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <span className="truncate font-mono text-meta font-medium text-foreground">
        {toolName}
      </span>
      <Block label="Arguments" text={argumentsText} />
      {detail ? (
        detail.result !== null ? (
          <Block label="Result" text={detail.result} />
        ) : (
          <span className="text-meta text-muted-foreground">
            No result recorded for this call.
          </span>
        )
      ) : (
        // The live result lives in the harness. This tier cannot reach it, so the row says
        // so rather than implying the call had no output.
        <span className="text-meta text-muted-foreground">
          Arguments mirrored from the run. The full result stays in the harness and is not
          reachable from here.
        </span>
      )}
    </div>
  );
}

export function ToolCallHover({
  detail,
  fallback,
  children,
}: {
  /** Live TrueForge detail, when the harness is reachable. */
  detail: ToolCallView | null | undefined;
  /** The mirrored preview, when this row is a tool call. */
  fallback?: ToolCallFallback | null;
  children: React.ReactNode;
}) {
  // A row with neither source is not a tool call (or its mirror was lost); it renders plain.
  if (!detail && !fallback) return <>{children}</>;

  return (
    <HoverCard>
      {/* Rendered as a button so the hover is reachable by keyboard focus, not pointer only.
          It carries the row's own layout, so the row looks unchanged until it is opened. */}
      <HoverCardTrigger
        render={
          <button
            type="button"
            className="flex w-full min-w-0 cursor-help items-center gap-4 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        }
      >
        {children}
      </HoverCardTrigger>

      <HoverCardContent className="flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2.5">
        <ToolCallBlocks detail={detail} fallback={fallback} />
      </HoverCardContent>
    </HoverCard>
  );
}

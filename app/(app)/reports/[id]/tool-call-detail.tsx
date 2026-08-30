import { CaretDown } from "@phosphor-icons/react/ssr";

import type { ToolCallDetail } from "@/lib/trueforge/client";

/**
 * The full detail of what the agent actually did, one collapsible entry per tool call.
 *
 * The detail is read live from TrueForge (see lib/reports/tool-calls.ts), not from the durable
 * session_event trace, so it carries the un-redacted arguments and the tool's result that the
 * trace is deliberately kept clear of. Everything is rendered as text, never as HTML: the agent
 * probes an untrusted target and may have absorbed prompt-injection content, so its arguments
 * and a tool's response are shown, not interpreted.
 *
 * Built on native <details>/<summary> rather than a stateful accordion: disclosure is a
 * platform feature, so this stays a server component with no client JS and no dependency. When
 * the live read comes back empty (TrueForge unreachable, the session gone, or a turn that made
 * no calls), it falls back to the same mirrored steps the lifecycle panel shows.
 */

function pretty(argumentsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argumentsJson), null, 2);
  } catch {
    // Not valid JSON: show whatever the model actually sent rather than hiding it.
    return argumentsJson;
  }
}

function stamp(iso: string | null): string {
  return iso ? iso.slice(11, 19) : "";
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-meta text-muted-foreground">{label}</span>
      {/* whitespace-pre-wrap keeps the JSON indentation and any line breaks; break-words stops a
          long unbroken token from pushing the card sideways. Text content only. */}
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-3 py-2 font-mono text-meta text-foreground">
        {text}
      </pre>
    </div>
  );
}

export function ToolCallDetailPanel({
  calls,
  fallback,
}: {
  calls: ToolCallDetail[];
  /** The mirrored tool-call steps to show when live detail is unavailable. */
  fallback: { type: string; at: string }[];
}) {
  if (calls.length === 0) {
    if (fallback.length === 0) {
      return (
        <p className="text-body text-muted-foreground">
          This run recorded no tool calls.
        </p>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        <p className="text-meta text-muted-foreground">
          Live detail is unavailable, so the recorded steps are shown without their arguments.
        </p>
        <ul className="flex flex-col">
          {fallback.map((event, index) => (
            <li
              key={index}
              className="flex items-baseline justify-between gap-4 border-b border-border/50 py-2 last:border-b-0"
            >
              <span className="min-w-0 truncate text-body text-foreground">{event.type}</span>
              <span className="shrink-0 font-mono text-meta tabular-nums text-muted-foreground">
                {event.at}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {calls.map((call, index) => (
        <li key={call.id} className="rounded-lg border border-border/50 bg-background">
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
              <span className="shrink-0 font-mono text-meta tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">
                {call.toolName}
              </span>
              {call.calledAt ? (
                <span className="shrink-0 font-mono text-meta tabular-nums text-muted-foreground">
                  {stamp(call.calledAt)}
                </span>
              ) : null}
              <CaretDown
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-300 group-open:rotate-180"
              />
            </summary>

            <div className="flex flex-col gap-3 border-t border-border/50 px-4 py-3">
              <Block label="Arguments" text={pretty(call.argumentsJson)} />
              {call.result !== null ? (
                <Block label="Result" text={call.result} />
              ) : (
                <span className="text-meta text-muted-foreground">
                  No result recorded for this call.
                </span>
              )}
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}

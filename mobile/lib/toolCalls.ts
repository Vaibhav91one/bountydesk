import type { CaseEvent } from "@/lib/types"

/**
 * The calls the agent made. The event mirror also carries `agent.scope_tool_denied` rows, which
 * annotate a call that already has its own row, so they are not counted or listed.
 */
export function toolCallsOnly(events: CaseEvent[]): CaseEvent[] {
  return events.filter((e) => !e.type.startsWith("agent.scope_tool_denied"))
}

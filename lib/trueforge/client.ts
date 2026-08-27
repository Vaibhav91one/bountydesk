import { TrueForge } from "@truefoundry/trueforge-sdk";

import { trueforgeApiKey, trueforgeUrl } from "@/lib/env";

/**
 * The interface bounty-desk actually needs, not the raw SDK surface. Kept deliberately small
 * so tests inject a fake implementation directly rather than faking HTTP or an async event
 * stream: `TurnSnapshot` already resolves a pending tool call's name and arguments (the SDK's
 * `getTurn` does not return those directly — only a `toolCallId` plus the id of the
 * `model.message` event that requested it, so the real implementation below correlates that
 * itself via `listTurnEvents`).
 */
export interface TrueForgeClient {
  createSession(): Promise<{ sessionId: string }>;
  /** `createTurn` starts a turn and returns immediately; the SDK documents it as generally
   * `running` while execution continues in the background. Nothing about a fresh turn implies
   * it has already reached a pending approval — callers must poll `getTurn` to find out. */
  createTurn(sessionId: string, input: TurnInput[]): Promise<{ turnId: string; snapshot: TurnSnapshot }>;
  getTurn(sessionId: string, turnId: string): Promise<TurnSnapshot>;
  /** What was actually submitted for a turn, for reconciling a decision already sent. */
  getTurnInput(sessionId: string, turnId: string): Promise<TurnInput[]>;
}

export type TurnInput =
  | { type: "user.message"; content: string }
  | {
      type: "user.tool_approval";
      threadId: string;
      toolCallId: string;
      approval: { status: "allow" } | { status: "deny"; reason?: string };
    };

/** One pending, gated tool call, with its arguments already resolved from the turn's events. */
export type PendingToolCall = {
  threadId: string;
  toolCallId: string;
  toolName: string;
  /** "mcp" for a real MCP-server tool; anything else is not one bounty-desk registered. */
  toolInfoType: string;
  argumentsJson: string;
};

export type TurnSnapshot =
  | { status: "running" }
  | { status: "awaiting_approval"; pending: PendingToolCall[] }
  /** Reached `done` with no pending action: the model finished without calling the gated
   * tool. Never inferred as an approval or a denial. */
  | { status: "done_no_action" }
  | { status: "error"; message: string }
  | { status: "cancelled" };

function isLoopback(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Resolves a `TurnStateDone` with pending `tool.approval_required` actions into
 * `PendingToolCall`s by walking the turn's events once and correlating each
 * `ToolCallRef.sourceEventId` back to the `model.message` event that made the call.
 *
 * Refuses (throws) rather than guesses when a referenced call can't be resolved: an
 * unresolvable pending call is a state the poller must surface loudly, not paper over.
 */
async function resolvePending(
  events: AsyncIterable<{ id: string; type: string; toolCalls?: RawToolCallLike[] }>,
  requiredActions: { type: string; threadId: string; toolCalls: { id: string; sourceEventId: string }[] }[],
): Promise<PendingToolCall[]> {
  const approvalActions = requiredActions.filter((a) => a.type === "tool.approval_required");
  if (approvalActions.length === 0) return [];

  const byId = new Map<string, { id: string; type: string; toolCalls?: RawToolCallLike[] }>();
  for await (const event of events) byId.set(event.id, event);

  const pending: PendingToolCall[] = [];
  for (const action of approvalActions) {
    for (const ref of action.toolCalls) {
      const source = byId.get(ref.sourceEventId);
      const call = source?.type === "model.message" ? source.toolCalls?.find((c) => c.id === ref.id) : undefined;
      if (!call) {
        throw new Error(
          `turn event ${ref.sourceEventId} does not contain the pending tool call ${ref.id}`,
        );
      }
      pending.push({
        threadId: action.threadId,
        toolCallId: call.id,
        toolName: call.function.name,
        toolInfoType: call.toolInfo?.type ?? "unknown",
        argumentsJson: call.function.arguments,
      });
    }
  }
  return pending;
}

/** The slice of the SDK's `ToolCall` shape this module actually reads. */
type RawToolCallLike = {
  id: string;
  function: { name: string; arguments: string };
  toolInfo?: { type: string };
};

export function createTrueForgeClient(opts: { fetchImpl?: typeof fetch } = {}): TrueForgeClient {
  const baseUrl = trueforgeUrl();
  const apiKey = trueforgeApiKey();

  if (!isLoopback(baseUrl) && !apiKey) {
    // trueforgeUrl() already enforces this; re-checked here so a future caller that
    // constructs the SDK client differently can't accidentally skip the guard.
    throw new Error(`refusing to connect to non-loopback TrueForge at ${baseUrl} with no API key`);
  }

  const client = new TrueForge({
    baseUrl,
    ...(apiKey ? { token: apiKey } : { auth: false as const }),
    ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
  });

  return {
    async createSession() {
      const res = await client.sessions.create({ agent: { name: "bountydesk" } });
      return { sessionId: res.data.id };
    },

    async createTurn(sessionId, input) {
      // createTurn (not createTurnStream) is the non-streaming method: it returns immediately,
      // generally with state.status "running" while the harness keeps executing in the
      // background. There is no "stream" flag on this request — the method itself is the
      // choice between the two transports.
      const res = await client.sessions.createTurn(sessionId, { input: input as never });
      const turn = res.data;
      const snapshot = await snapshotFromTurn(client, sessionId, turn);
      return { turnId: turn.id, snapshot };
    },

    async getTurn(sessionId, turnId) {
      const res = await client.sessions.getTurn(sessionId, turnId);
      return snapshotFromTurn(client, sessionId, res.data);
    },

    async getTurnInput(sessionId, turnId) {
      const res = await client.sessions.getTurn(sessionId, turnId);
      return (res.data.input ?? []) as unknown as TurnInput[];
    },
  };
}

async function snapshotFromTurn(
  client: TrueForge,
  sessionId: string,
  turn: { id: string; state: { status: string; requiredActions?: unknown[]; message?: string } },
): Promise<TurnSnapshot> {
  const state = turn.state;

  if (state.status === "running") return { status: "running" };
  if (state.status === "error") return { status: "error", message: state.message ?? "unknown error" };
  if (state.status === "cancelled") return { status: "cancelled" };

  // status === "done" — which, per the SDK, can still carry a pending approval in
  // requiredActions. "done" alone never means "finished"; requiredActions is what decides.
  const requiredActions = (state.requiredActions ?? []) as {
    type: string;
    threadId: string;
    toolCalls: { id: string; sourceEventId: string }[];
  }[];

  if (requiredActions.length === 0) return { status: "done_no_action" };

  const page = (await client.sessions.listTurnEvents(sessionId, turn.id)) as unknown as AsyncIterable<{
    id: string;
    type: string;
    toolCalls?: RawToolCallLike[];
  }>;
  const pending = await resolvePending(page, requiredActions);
  if (pending.length === 0) return { status: "done_no_action" };
  return { status: "awaiting_approval", pending };
}

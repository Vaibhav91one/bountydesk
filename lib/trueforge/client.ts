import { TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";

import { trueforgeApiKey, trueforgeUrl } from "@/lib/env";

/**
 * The interface bounty-desk actually needs, not the raw SDK surface. Kept deliberately small
 * so tests inject a fake implementation directly rather than faking HTTP or an async event
 * stream: `TurnSnapshot` already resolves a pending tool call's name and arguments (the SDK's
 * `getTurn` does not return those directly. It returns only a `toolCallId` plus the id of the
 * `model.message` event that requested it, so the real implementation below correlates that
 * itself via `listTurnEvents`).
 */
export interface TrueForgeClient {
  createSession(opts?: { signal?: AbortSignal }): Promise<{ sessionId: string }>;
  deleteSession(sessionId: string, opts?: { signal?: AbortSignal }): Promise<void>;
  /** `createTurn` starts a turn and returns immediately; the SDK documents it as generally
   * `running` while execution continues in the background. Nothing about a fresh turn implies
   * it has already reached a pending approval. Callers must poll `getTurn` to find out. */
  createTurn(
    sessionId: string,
    input: TurnInput[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ turnId: string; snapshot: TurnSnapshot }>;
  getTurn(sessionId: string, turnId: string, opts?: { signal?: AbortSignal }): Promise<TurnSnapshot>;
  /** What was actually submitted for a turn, for reconciling a decision already sent. */
  getTurnInput(
    sessionId: string,
    turnId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<TurnInput[]>;
  /** Find an already-created turn carrying the exact input after an ambiguous retry. */
  findTurnByInput?(
    sessionId: string,
    input: TurnInput[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ turnId: string } | null>;
  /**
   * Tool calls the turn has made since `opts.since`, in chronological order. Unlike
   * `PendingToolCall`, this is not limited to a call still awaiting approval: it is the
   * poller's only way to see what the agent has actually done mid-investigation, for mirroring
   * into `session_event` (see lib/agent-sessions/poller.ts). `since` is an event id from a
   * previous call's `cursor`; omitted, every call the turn has made so far comes back. Walks
   * the turn's events newest-first and stops at the first one at or before `since`, so a poll
   * that is only a few tool calls ahead of the last one doesn't re-read the turn's whole
   * history to find them. `cursor` is the newest event id observed this call (`since` unchanged
   * when nothing new was found), for the caller to persist and pass back next time. Optional so
   * a fake client built only to exercise the approval path doesn't have to implement it.
   */
  listToolCalls?(
    sessionId: string,
    turnId: string,
    opts?: { signal?: AbortSignal; since?: string },
  ): Promise<{ calls: ObservedToolCall[]; cursor: string | null }>;
  /**
   * The agent's closing prose for a turn: the text of its newest `model.message` on the root
   * thread that carries any, or null if none does. This is the reproduction steps, finding and
   * remediation the agent wrote at the end of its investigation, which the poller persists into
   * `agent_session.final_summary` (see lib/agent-sessions/poller.ts). Walks the turn's events
   * newest-first and stops at the first message with text, so it never reads the whole history.
   * A pure tool-call message (null content) is skipped, so the publish_verdict call itself does
   * not shadow the summary that precedes it. Optional so a fake client built only for the
   * approval path need not implement it.
   */
  getFinalSummary?(
    sessionId: string,
    turnId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string | null>;
  /**
   * Full detail for every tool call across a whole session: name, un-redacted arguments, and the
   * tool's own response, correlated by id, merged chronologically over every turn and deduped by
   * tool-call id. It reads the whole session, not one turn, because approval submission and the
   * driver overwrite `agent_session.turn_id` with each chained turn (see
   * lib/approval-submission/worker.ts and lib/analysis/trueforge-driver.ts), so a single stored
   * turn id is only the latest turn and would drop every call the investigation made before an
   * approval.
   *
   * This is the reviewer-facing read the case file renders live, not a poller path: unlike
   * `listToolCalls` (whose output is mirrored into the durable, append-only `session_event` and so
   * carries only an allowlisted argument preview), nothing here is persisted, which is exactly why
   * the full arguments and result are safe to return. They stay in TrueForge, which already holds
   * the whole transcript, and reach the reviewer's page and no further. Optional so a fake client
   * built only for the approval path need not implement it.
   */
  listSessionToolCallDetails?(
    sessionId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<ToolCallDetail[]>;
}

export type ObservedToolCall = {
  /** The tool call's own id, stable across repeated polls of the same turn -- the dedup key
   * the poller mirrors events on. */
  id: string;
  toolName: string;
  argumentsJson: string;
};

/**
 * One tool call and its outcome, as TrueForge recorded them. `result` is the tool's response
 * text, or null when the turn has no `tool.response` for this call yet (still running, or the
 * harness never produced one). Timestamps are the raw ISO strings from the events; the caller
 * formats them.
 */
export type ToolCallDetail = {
  id: string;
  toolName: string;
  /** "mcp" for a real MCP-server tool, "truefoundry-system" for a built-in, "unknown" if absent. */
  toolInfoType: string;
  argumentsJson: string;
  result: string | null;
  calledAt: string | null;
  respondedAt: string | null;
};

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
  events: AsyncIterable<TrueForgeApi.SessionEvent>,
  requiredActions: { type: string; threadId: string; toolCalls: { id: string; sourceEventId: string }[] }[],
): Promise<PendingToolCall[]> {
  const approvalActions = requiredActions.filter((a) => a.type === "tool.approval_required");
  if (approvalActions.length === 0) return [];

  const byId = new Map<string, TrueForgeApi.SessionEvent>();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTurnInput(value: unknown): TurnInput {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("malformed TrueForge turn input");
  }
  if (value.type === "user.message") {
    if (typeof value.content !== "string") {
      throw new Error("malformed TrueForge user.message input");
    }
    return { type: "user.message", content: value.content };
  }
  if (value.type === "user.tool_approval") {
    if (
      typeof value.threadId !== "string" ||
      typeof value.toolCallId !== "string" ||
      !isRecord(value.approval)
    ) {
      throw new Error("malformed TrueForge user.tool_approval input");
    }
    if (value.approval.status === "allow") {
      return {
        type: "user.tool_approval",
        threadId: value.threadId,
        toolCallId: value.toolCallId,
        approval: { status: "allow" },
      };
    }
    if (
      value.approval.status === "deny" &&
      (value.approval.reason === undefined || typeof value.approval.reason === "string")
    ) {
      return {
        type: "user.tool_approval",
        threadId: value.threadId,
        toolCallId: value.toolCallId,
        approval: {
          status: "deny",
          ...(value.approval.reason ? { reason: value.approval.reason } : {}),
        },
      };
    }
    throw new Error("malformed TrueForge user.tool_approval decision");
  }
  throw new Error(`unsupported TrueForge turn input ${value.type}`);
}

function sameTurnInput(left: TurnInput[], right: TurnInput[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

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
    async createSession(requestOpts) {
      const res = await client.sessions.create(
        { agent: { name: "bountydesk" } },
        { abortSignal: requestOpts?.signal },
      );
      return { sessionId: res.data.id };
    },

    async deleteSession(sessionId, requestOpts) {
      await client.sessions.delete(sessionId, { abortSignal: requestOpts?.signal });
    },

    async createTurn(sessionId, input, requestOpts) {
      // createTurn (not createTurnStream) is the non-streaming method: it returns immediately,
      // generally with state.status "running" while the harness keeps executing in the
      // background. There is no "stream" flag on this request. The method itself is the
      // choice between the two transports.
      const res = await client.sessions.createTurn(
        sessionId,
        { input: input as never },
        { abortSignal: requestOpts?.signal },
      );
      const turn = res.data;
      const snapshot = await snapshotFromTurn(client, sessionId, turn, requestOpts);
      return { turnId: turn.id, snapshot };
    },

    async getTurn(sessionId, turnId, requestOpts) {
      const res = await client.sessions.getTurn(sessionId, turnId, {
        abortSignal: requestOpts?.signal,
      });
      return snapshotFromTurn(client, sessionId, res.data, requestOpts);
    },

    async getTurnInput(sessionId, turnId, requestOpts) {
      const res = await client.sessions.getTurn(sessionId, turnId, {
        abortSignal: requestOpts?.signal,
      });
      return (res.data.input ?? []).map(normalizeTurnInput);
    },

    async findTurnByInput(sessionId, input, requestOpts) {
      const turns = await client.sessions.listTurns(sessionId, undefined, {
        abortSignal: requestOpts?.signal,
      });
      for await (const turn of turns) {
        const candidate = (turn.input ?? []).map(normalizeTurnInput);
        if (sameTurnInput(candidate, input)) return { turnId: turn.id };
      }
      return null;
    },

    async listToolCalls(sessionId, turnId, requestOpts) {
      // Newest first, and stop at `since`: event ids are monotonic ULIDs, so everything at or
      // before the last-seen id is history the caller already has. Without this a poll near
      // the end of a long turn would walk every page back to the turn's start just to find the
      // handful of tool calls made since the previous poll.
      const page = await client.sessions.listTurnEvents(
        sessionId,
        turnId,
        { order: "desc" },
        { abortSignal: requestOpts?.signal },
      );
      return collectToolCalls(page, requestOpts?.since);
    },

    async getFinalSummary(sessionId, turnId, requestOpts) {
      const page = await client.sessions.listTurnEvents(
        sessionId,
        turnId,
        { order: "desc" },
        { abortSignal: requestOpts?.signal },
      );
      for await (const event of page) {
        if (event.type !== "model.message" || event.threadId !== "main") continue;
        const text = messageText(event.content);
        if (text) return text;
      }
      return null;
    },

    async listSessionToolCallDetails(sessionId, requestOpts) {
      // Enumerate the session's turns, then read each one's events. listTurns has no order
      // parameter and its default is unspecified, so the turns are sorted by creation time here;
      // that is the order the investigation happened in, and it makes the concatenation below
      // chronological without depending on the server's page order.
      const turnsPage = await client.sessions.listTurns(sessionId, undefined, {
        abortSignal: requestOpts?.signal,
      });
      const turns: { id: string; createdAt: string }[] = [];
      for await (const turn of turnsPage) turns.push({ id: turn.id, createdAt: turn.createdAt });
      turns.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

      // Deduped by tool-call id across turns: a call belongs to exactly one turn, but the id is
      // the stable key everywhere else in this client, so guarding on it keeps a repeated event
      // (a retried page, an id that recurs) from showing the same call twice.
      const seen = new Set<string>();
      const merged: ToolCallDetail[] = [];
      for (const turn of turns) {
        // Oldest first within the turn, unlike the poller's paths: this builds a complete, ordered
        // picture for a reviewer, so there is no `since` cutoff to stop early for.
        const page = await client.sessions.listTurnEvents(
          sessionId,
          turn.id,
          { order: "asc" },
          { abortSignal: requestOpts?.signal },
        );
        for (const detail of await collectToolCallDetails(page)) {
          if (seen.has(detail.id)) continue;
          seen.add(detail.id);
          merged.push(detail);
        }
      }
      return merged;
    },
  };
}

/**
 * Correlate a turn's `model.message` tool calls with their `tool.response` events into full
 * per-call detail, in chronological order. A response always follows its call, so responses are
 * stashed by `toolCallId` on the single forward pass and merged onto the calls at the end; a
 * call with no matching response keeps a null result, which is the honest record of one still
 * running or one the harness answered without response text.
 */
async function collectToolCallDetails(
  events: AsyncIterable<TrueForgeApi.SessionEvent>,
): Promise<ToolCallDetail[]> {
  const details: ToolCallDetail[] = [];
  const responses = new Map<string, { content: string; createdAt: string }>();

  for await (const event of events) {
    if (event.type === "model.message") {
      for (const call of event.toolCalls ?? []) {
        details.push({
          id: call.id,
          toolName: call.function.name,
          toolInfoType: call.toolInfo?.type ?? "unknown",
          argumentsJson: call.function.arguments,
          result: null,
          calledAt: event.createdAt ?? null,
          respondedAt: null,
        });
      }
    } else if (event.type === "tool.response") {
      responses.set(event.toolCallId, { content: event.content, createdAt: event.createdAt });
    }
  }

  for (const detail of details) {
    const response = responses.get(detail.id);
    if (response) {
      detail.result = response.content;
      detail.respondedAt = response.createdAt;
    }
  }
  return details;
}

/**
 * The plain text of a model.message's content, or null when it has none. Content is either a
 * string or an array of parts; only the text parts contribute, so a message that is all tool
 * calls or a refusal returns null and the caller keeps looking.
 */
function messageText(content: TrueForgeApi.ModelMessageEventContent | null | undefined): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Array.isArray(content)) return null;

  const text = content
    .filter((part): part is TrueForgeApi.ChatCompletionContentPartText => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * Every `model.message` event's tool calls newer than `since`, walking `events` newest-first
 * and returning them back in chronological order. `cursor` is the newest event id seen (or
 * `since` unchanged if the walk found nothing past it), for the caller to persist.
 */
async function collectToolCalls(
  events: AsyncIterable<TrueForgeApi.SessionEvent>,
  since?: string,
): Promise<{ calls: ObservedToolCall[]; cursor: string | null }> {
  const calls: ObservedToolCall[] = [];
  let cursor: string | null = since ?? null;

  for await (const event of events) {
    if (since !== undefined && event.id <= since) break;
    if (cursor === null || event.id > cursor) cursor = event.id;

    if (event.type !== "model.message") continue;
    for (const call of event.toolCalls ?? []) {
      calls.push({ id: call.id, toolName: call.function.name, argumentsJson: call.function.arguments });
    }
  }

  calls.reverse();
  return { calls, cursor };
}

async function snapshotFromTurn(
  client: TrueForge,
  sessionId: string,
  turn: { id: string; state: { status: string; requiredActions?: unknown[]; message?: string } },
  requestOpts?: { signal?: AbortSignal },
): Promise<TurnSnapshot> {
  const state = turn.state;

  if (state.status === "running") return { status: "running" };
  if (state.status === "error") return { status: "error", message: state.message ?? "unknown error" };
  if (state.status === "cancelled") return { status: "cancelled" };
  if (state.status !== "done") {
    throw new Error(`unsupported TrueForge turn state ${state.status}`);
  }

  // A done turn can still carry a pending approval in
  // requiredActions. "done" alone never means "finished"; requiredActions is what decides.
  const requiredActions = (state.requiredActions ?? []) as {
    type: string;
    threadId: string;
    toolCalls: { id: string; sourceEventId: string }[];
  }[];

  if (requiredActions.length === 0) return { status: "done_no_action" };
  const unsupportedAction = requiredActions.find(
    (action) => action.type !== "tool.approval_required",
  );
  if (unsupportedAction) {
    throw new Error(`unsupported TrueForge required action ${unsupportedAction.type}`);
  }

  // The SDK Page is an AsyncIterable and follows its own continuation tokens.
  const page = await client.sessions.listTurnEvents(sessionId, turn.id, undefined, {
    abortSignal: requestOpts?.signal,
  });
  const pending = await resolvePending(page, requiredActions);
  if (pending.length === 0) return { status: "done_no_action" };
  return { status: "awaiting_approval", pending };
}

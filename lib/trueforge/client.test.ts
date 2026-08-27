import assert from "node:assert/strict";
import test from "node:test";

process.env.TRUEFORGE_URL = "http://localhost:8790";
process.env.TRUEFORGE_API_KEY = "";

import { createTrueForgeClient } from "./client";

/**
 * Fixtures below are the SDK's actual over-the-wire (snake_case) shape, read directly from
 * `node_modules/@truefoundry/trueforge-sdk/dist/esm/serialization/**\/*.d.mts` (e.g.
 * `Turn.Raw`, `TurnStateDone.Raw`, `ToolApprovalRequiredEvent.Raw`, `ModelMessageEvent.Raw`),
 * not the deserialized camelCase TS types this module reads — those two are different
 * spellings of the same data, and a fixture built from the wrong one silently passes without
 * exercising real deserialization. An earlier draft of these tests used camelCase fixtures and
 * still passed, only because the SDK's schema validator degrades to a lenient passthrough
 * instead of failing loudly on a mismatch; it printed unread warnings the whole time.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function withFetch(stub: typeof fetch, run: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  return run().finally(() => {
    globalThis.fetch = real;
  });
}

test("createSession returns the session id from a real-shape GetSessionResponse", async () => {
  await withFetch(
    (async () =>
      json({
        data: {
          id: "sess_1",
          agent: { type: "reference", name: "bountydesk" },
          created_at: "2026-01-01T00:00:00Z",
          created_by: "svc",
          title: null,
          updated_at: "2026-01-01T00:00:00Z",
        },
      })) as typeof fetch,
    async () => {
      const client = createTrueForgeClient();
      const { sessionId } = await client.createSession();
      assert.equal(sessionId, "sess_1");
    },
  );
});

test("createTurn resolves to running when the turn has not settled yet", async () => {
  await withFetch(
    (async () =>
      json({
        data: {
          id: "turn_1",
          session_id: "sess_1",
          previous_turn_id: null,
          created_at: "2026-01-01T00:00:00Z",
          state: { status: "running" },
        },
      })) as typeof fetch,
    async () => {
      const client = createTrueForgeClient();
      const { turnId, snapshot } = await client.createTurn("sess_1", [{ type: "user.message", content: "hi" }]);
      assert.equal(turnId, "turn_1");
      assert.deepEqual(snapshot, { status: "running" });
    },
  );
});

test("getTurn resolves done with no requiredActions to done_no_action", async () => {
  await withFetch(
    (async () =>
      json({
        data: {
          id: "turn_1",
          session_id: "sess_1",
          previous_turn_id: null,
          created_at: "2026-01-01T00:00:00Z",
          state: {
            status: "done",
            completed_at: "2026-01-01T00:00:01Z",
            required_actions: [],
            output: null,
          },
        },
      })) as typeof fetch,
    async () => {
      const client = createTrueForgeClient();
      const snapshot = await client.getTurn("sess_1", "turn_1");
      assert.deepEqual(snapshot, { status: "done_no_action" });
    },
  );
});

test("getTurn resolves a pending publish_verdict call by correlating source_event_id through listTurnEvents", async () => {
  const turnResponse = {
    data: {
      id: "turn_1",
      session_id: "sess_1",
      previous_turn_id: null,
      created_at: "2026-01-01T00:00:00Z",
      state: {
        status: "done",
        completed_at: "2026-01-01T00:00:01Z",
        output: null,
        required_actions: [
          {
            type: "tool.approval_required",
            id: "evt_approval",
            created_at: "2026-01-01T00:00:01Z",
            thread_id: "main",
            tool_calls: [{ id: "call_1", source_event_id: "evt_model_msg" }],
          },
        ],
      },
    },
  };
  const eventsResponse = {
    data: [
      {
        type: "turn.created",
        id: "evt_turn_created",
        created_at: "2026-01-01T00:00:00Z",
        turn_id: "turn_1",
        state: { status: "running" },
      },
      {
        type: "model.message",
        id: "evt_model_msg",
        created_at: "2026-01-01T00:00:00.5Z",
        thread_id: "main",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "publish_verdict", arguments: JSON.stringify({ capability: "cap_abc" }) },
            tool_info: { type: "mcp", name: "publish_verdict", server_id: "srv_1", server_name: "bountydesk" },
          },
        ],
      },
    ],
    pagination: { limit: 100, next_page_token: null, previous_page_token: null },
  };

  const calls: string[] = [];
  const stub: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/events")) return json(eventsResponse);
    return json(turnResponse);
  }) as typeof fetch;

  await withFetch(stub, async () => {
    const client = createTrueForgeClient();
    const snapshot = await client.getTurn("sess_1", "turn_1");
    assert.equal(snapshot.status, "awaiting_approval");
    if (snapshot.status !== "awaiting_approval") return;
    assert.equal(snapshot.pending.length, 1);
    const [pending] = snapshot.pending;
    assert.equal(pending.threadId, "main");
    assert.equal(pending.toolCallId, "call_1");
    assert.equal(pending.toolName, "publish_verdict");
    assert.equal(pending.toolInfoType, "mcp");
    assert.deepEqual(JSON.parse(pending.argumentsJson), { capability: "cap_abc" });
  });

  assert.ok(calls.some((u) => u.includes("/events")), "must resolve the pending call via listTurnEvents");
});

test("getTurn refuses a pending call whose source event cannot be resolved", async () => {
  const turnResponse = {
    data: {
      id: "turn_1",
      session_id: "sess_1",
      previous_turn_id: null,
      created_at: "2026-01-01T00:00:00Z",
      state: {
        status: "done",
        completed_at: "2026-01-01T00:00:01Z",
        output: null,
        required_actions: [
          {
            type: "tool.approval_required",
            id: "evt_approval",
            created_at: "2026-01-01T00:00:01Z",
            thread_id: "main",
            tool_calls: [{ id: "call_1", source_event_id: "evt_missing" }],
          },
        ],
      },
    },
  };
  const stub: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/events")) {
      return json({ data: [], pagination: { limit: 100, next_page_token: null, previous_page_token: null } });
    }
    return json(turnResponse);
  }) as typeof fetch;

  await withFetch(stub, async () => {
    const client = createTrueForgeClient();
    await assert.rejects(() => client.getTurn("sess_1", "turn_1"));
  });
});

test("getTurn maps error and cancelled states without inferring approval or denial", async () => {
  await withFetch(
    (async () =>
      json({
        data: {
          id: "turn_1",
          session_id: "sess_1",
          previous_turn_id: null,
          created_at: "2026-01-01T00:00:00Z",
          state: { status: "error", completed_at: "2026-01-01T00:00:01Z", message: "model provider timeout" },
        },
      })) as typeof fetch,
    async () => {
      const client = createTrueForgeClient();
      const snapshot = await client.getTurn("sess_1", "turn_1");
      assert.deepEqual(snapshot, { status: "error", message: "model provider timeout" });
    },
  );

  await withFetch(
    (async () =>
      json({
        data: {
          id: "turn_2",
          session_id: "sess_1",
          previous_turn_id: null,
          created_at: "2026-01-01T00:00:00Z",
          state: { status: "cancelled", completed_at: "2026-01-01T00:00:01Z", reason: "superseded" },
        },
      })) as typeof fetch,
    async () => {
      const client = createTrueForgeClient();
      const snapshot = await client.getTurn("sess_1", "turn_2");
      assert.deepEqual(snapshot, { status: "cancelled" });
    },
  );
});

test("refuses a non-loopback TrueForge URL with no API key, before any network call", () => {
  process.env.TRUEFORGE_URL = "https://truforge.example.com";
  process.env.TRUEFORGE_API_KEY = "";
  try {
    assert.throws(() => createTrueForgeClient());
  } finally {
    process.env.TRUEFORGE_URL = "http://localhost:8790";
  }
});

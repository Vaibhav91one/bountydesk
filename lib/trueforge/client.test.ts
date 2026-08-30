import assert from "node:assert/strict";
import test from "node:test";

process.env.TRUEFORGE_URL = "http://localhost:8790";
process.env.TRUEFORGE_API_KEY = "";

import { createTrueForgeClient } from "./client";

/**
 * Fixtures below are the SDK's actual over-the-wire (snake_case) shape, read directly from
 * `node_modules/@truefoundry/trueforge-sdk/dist/esm/serialization/**\/*.d.mts` (e.g.
 * `Turn.Raw`, `TurnStateDone.Raw`, `ToolApprovalRequiredEvent.Raw`, `ModelMessageEvent.Raw`),
 * not the deserialized camelCase TS types this module reads. Those two are different
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

async function withExpectedValidationWarning(run: () => Promise<void>): Promise<void> {
  const real = console.warn;
  const warnings: string[] = [];
  console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
  try {
    await run();
  } finally {
    console.warn = real;
  }
  assert.ok(
    warnings.some((warning) => warning.includes("Failed to validate.")),
    "the fixture must exercise the SDK's lenient invalid-response path",
  );
}

test("createSession returns the session id from a real-shape GetSessionResponse", async () => {
  await withFetch(
    (async () =>
      json({
        data: {
          id: "sess_1",
          agent: { type: "reference", id: "agent_1", name: "bountydesk" },
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
        previous_turn_id: null,
        thread_id: "main",
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

/** Newest first, matching the real server's answer to the `order: "desc"` request this client
 * always sends -- the fixture below stands in for that server, not for the mock's own default. */
const NEWEST_FIRST_EVENTS = [
  {
    type: "model.message",
    id: "evt_3",
    created_at: "2026-01-01T00:00:02Z",
    thread_id: "main",
    content: null,
    tool_calls: [
      {
        id: "call_2",
        type: "function",
        function: { name: "http_probe", arguments: JSON.stringify({ path: "/rest/products/search" }) },
        tool_info: { type: "mcp", name: "http_probe", server_id: "srv_1", server_name: "bountydesk" },
      },
    ],
  },
  // A plain text reply with no tool call at all: must not blow up on a missing tool_calls
  // array, and must contribute nothing to the result.
  {
    type: "model.message",
    id: "evt_2",
    created_at: "2026-01-01T00:00:01Z",
    thread_id: "main",
    content: "thinking out loud",
  },
  {
    type: "model.message",
    id: "evt_1",
    created_at: "2026-01-01T00:00:00.5Z",
    thread_id: "main",
    content: null,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "scope_check", arguments: JSON.stringify({ path: "/rest/products" }) },
        tool_info: { type: "mcp", name: "scope_check", server_id: "srv_1", server_name: "bountydesk" },
      },
    ],
  },
];

test("listToolCalls collects every model.message event's tool calls, oldest first, and returns the newest event id as the cursor", async () => {
  await withFetch(
    (async () =>
      json({
        data: NEWEST_FIRST_EVENTS,
        pagination: { limit: 100, next_page_token: null, previous_page_token: null },
      })) as typeof fetch,
    async () => {
      const client = createTrueForgeClient();
      const result = await client.listToolCalls?.("sess_1", "turn_1");
      assert.deepEqual(result, {
        calls: [
          { id: "call_1", toolName: "scope_check", argumentsJson: JSON.stringify({ path: "/rest/products" }) },
          {
            id: "call_2",
            toolName: "http_probe",
            argumentsJson: JSON.stringify({ path: "/rest/products/search" }),
          },
        ],
        cursor: "evt_3",
      });
    },
  );
});

test("listToolCalls stops at `since` instead of re-walking the turn's whole history", async () => {
  const requestedUrls: string[] = [];
  await withFetch(
    (async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return json({
        data: NEWEST_FIRST_EVENTS,
        pagination: { limit: 100, next_page_token: null, previous_page_token: null },
      });
    }) as typeof fetch,
    async () => {
      const client = createTrueForgeClient();
      // Already caught up through evt_2: only evt_3's call_2 is new. evt_1's call_1 must not
      // reappear, and the walk must stop instead of paging into history it already has.
      const result = await client.listToolCalls?.("sess_1", "turn_1", { since: "evt_2" });
      assert.deepEqual(result, {
        calls: [
          {
            id: "call_2",
            toolName: "http_probe",
            argumentsJson: JSON.stringify({ path: "/rest/products/search" }),
          },
        ],
        cursor: "evt_3",
      });
    },
  );

  assert.ok(
    requestedUrls.some((u) => u.includes("order=desc")),
    "must request newest-first so a since cutoff can stop early",
  );
});

test("listToolCalls leaves the cursor unchanged when nothing new has happened", async () => {
  await withFetch(
    (async () =>
      json({
        data: NEWEST_FIRST_EVENTS,
        pagination: { limit: 100, next_page_token: null, previous_page_token: null },
      })) as typeof fetch,
    async () => {
      const client = createTrueForgeClient();
      const result = await client.listToolCalls?.("sess_1", "turn_1", { since: "evt_3" });
      assert.deepEqual(result, { calls: [], cursor: "evt_3" });
    },
  );
});

test("getTurn follows event pagination when the source event is on a later page", async () => {
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
  const calls: string[] = [];
  const stub: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (!url.includes("/events")) return json(turnResponse);
    if (!url.includes("page_token=page-2")) {
      return json({
        data: [],
        pagination: { limit: 100, next_page_token: "page-2", previous_page_token: null },
      });
    }
    return json({
      data: [
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
              function: {
                name: "publish_verdict",
                arguments: JSON.stringify({ capability: "cap_abc" }),
              },
              tool_info: {
                type: "mcp",
                name: "publish_verdict",
                server_id: "srv_1",
                server_name: "bountydesk",
              },
            },
          ],
        },
      ],
      pagination: { limit: 100, next_page_token: null, previous_page_token: "page-1" },
    });
  }) as typeof fetch;

  await withFetch(stub, async () => {
    const client = createTrueForgeClient();
    const snapshot = await client.getTurn("sess_1", "turn_1");
    assert.equal(snapshot.status, "awaiting_approval");
  });
  assert.ok(calls.some((url) => url.includes("page_token=page-2")));
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

test("getTurn refuses an unknown provider state", async () => {
  await withFetch(
    (async () =>
      json({
        data: {
          id: "turn_1",
          session_id: "sess_1",
          previous_turn_id: null,
          created_at: "2026-01-01T00:00:00Z",
          state: { status: "paused_by_provider" },
        },
      })) as typeof fetch,
    async () => {
      const client = createTrueForgeClient();
      await withExpectedValidationWarning(() =>
        assert.rejects(
          () => client.getTurn("sess_1", "turn_1"),
          /unsupported TrueForge turn state paused_by_provider/,
        ),
      );
    },
  );
});

test("getTurn refuses a required action that the approval worker cannot handle", async () => {
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
            output: null,
            required_actions: [
              {
                type: "mcp.auth_required",
                id: "evt_auth",
                created_at: "2026-01-01T00:00:01Z",
                thread_id: "main",
                mcp_servers: [],
              },
            ],
          },
        },
      })) as typeof fetch,
    async () => {
      const client = createTrueForgeClient();
      await assert.rejects(
        () => client.getTurn("sess_1", "turn_1"),
        /unsupported TrueForge required action mcp.auth_required/,
      );
    },
  );
});

test("getTurnInput refuses an input variant the reconciliation worker cannot interpret", async () => {
  await withFetch(
    (async () =>
      json({
        data: {
          id: "turn_1",
          session_id: "sess_1",
          previous_turn_id: null,
          created_at: "2026-01-01T00:00:00Z",
          state: { status: "running" },
          input: [{ type: "provider.private_input", value: "opaque" }],
        },
      })) as typeof fetch,
    async () => {
      const client = createTrueForgeClient();
      await withExpectedValidationWarning(() =>
        assert.rejects(
          () => client.getTurnInput("sess_1", "turn_1"),
          /unsupported TrueForge turn input provider.private_input/,
        ),
      );
    },
  );
});

test("getTurnInput normalizes the exact approval input used for reconciliation", async () => {
  await withFetch(
    (async () =>
      json({
        data: {
          id: "turn_approval",
          session_id: "sess_1",
          previous_turn_id: "turn_1",
          created_at: "2026-01-01T00:00:02Z",
          state: { status: "running" },
          input: [
            {
              type: "user.tool_approval",
              thread_id: "main",
              tool_call_id: "call_1",
              approval: { status: "allow" },
            },
          ],
        },
      })) as typeof fetch,
    async () => {
      const client = createTrueForgeClient();
      assert.deepEqual(await client.getTurnInput("sess_1", "turn_approval"), [
        {
          type: "user.tool_approval",
          threadId: "main",
          toolCallId: "call_1",
          approval: { status: "allow" },
        },
      ]);
    },
  );
});

/** A single turn's over-the-wire event list: one call answered by a tool.response, and one call
 * still awaiting a response. Keyed on tool_call_id, not position, so the merge is order-agnostic
 * and a call with no matching response keeps a null result. */
const firstTurnEvents = [
  {
    type: "model.message",
    id: "evt_1",
    created_at: "2026-01-01T00:00:00.5Z",
    thread_id: "main",
    content: null,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "scope_check", arguments: JSON.stringify({ path: "/rest/products" }) },
        tool_info: { type: "mcp", name: "scope_check", server_id: "srv_1", server_name: "bountydesk" },
      },
    ],
  },
  {
    type: "tool.response",
    id: "evt_2",
    created_at: "2026-01-01T00:00:01Z",
    thread_id: "main",
    tool_call_id: "call_1",
    content: "in scope",
  },
  {
    type: "model.message",
    id: "evt_3",
    created_at: "2026-01-01T00:00:02Z",
    thread_id: "main",
    content: null,
    tool_calls: [
      {
        id: "call_2",
        type: "function",
        function: { name: "http_probe", arguments: JSON.stringify({ path: "/rest/products/search" }) },
        tool_info: { type: "mcp", name: "http_probe", server_id: "srv_1", server_name: "bountydesk" },
      },
    ],
  },
];

const rawTurn = (id: string, createdAt: string) => ({
  id,
  session_id: "sess_1",
  previous_turn_id: null,
  created_at: createdAt,
  state: { status: "running" },
});

const turnEventsUrl = (turnId: string) => `/turns/${turnId}/`;

test("listSessionToolCallDetails correlates each call with its tool.response, in call order", async () => {
  const requestedUrls: string[] = [];
  await withFetch(
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/events")) {
        return json({
          data: firstTurnEvents,
          pagination: { limit: 100, next_page_token: null, previous_page_token: null },
        });
      }
      return json({
        data: [rawTurn("turn_1", "2026-01-01T00:00:00Z")],
        pagination: { limit: 100, next_page_token: null, previous_page_token: null },
      });
    }) as typeof fetch,
    async () => {
      const client = createTrueForgeClient();
      const details = await client.listSessionToolCallDetails?.("sess_1");
      assert.deepEqual(details, [
        {
          id: "call_1",
          toolName: "scope_check",
          toolInfoType: "mcp",
          argumentsJson: JSON.stringify({ path: "/rest/products" }),
          result: "in scope",
          calledAt: "2026-01-01T00:00:00.5Z",
          respondedAt: "2026-01-01T00:00:01Z",
        },
        {
          id: "call_2",
          toolName: "http_probe",
          toolInfoType: "mcp",
          argumentsJson: JSON.stringify({ path: "/rest/products/search" }),
          result: null,
          calledAt: "2026-01-01T00:00:02Z",
          respondedAt: null,
        },
      ]);
    },
  );

  assert.ok(
    requestedUrls.some((u) => u.includes("order=asc")),
    "must read each turn oldest-first so calls render in the order they happened",
  );
});

test("listSessionToolCallDetails merges every turn, oldest first, not just the latest chained turn", async () => {
  // The bug this guards: a call in an earlier turn (turn_1) must survive a later approval turn
  // (turn_2) overwriting agent_session.turn_id. The two turns are returned newest-first by the
  // turns list to prove the method sorts by created_at rather than trusting page order.
  const secondTurnEvents = [
    {
      type: "model.message",
      id: "evt_10",
      created_at: "2026-01-01T00:01:00Z",
      thread_id: "main",
      content: null,
      tool_calls: [
        {
          id: "call_9",
          type: "function",
          function: { name: "publish_verdict", arguments: JSON.stringify({ capability: "cap_abc" }) },
          tool_info: { type: "mcp", name: "publish_verdict", server_id: "srv_1", server_name: "bountydesk" },
        },
      ],
    },
  ];

  await withFetch(
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(turnEventsUrl("turn_1"))) {
        return json({
          data: firstTurnEvents,
          pagination: { limit: 100, next_page_token: null, previous_page_token: null },
        });
      }
      if (url.includes(turnEventsUrl("turn_2"))) {
        return json({
          data: secondTurnEvents,
          pagination: { limit: 100, next_page_token: null, previous_page_token: null },
        });
      }
      return json({
        data: [
          rawTurn("turn_2", "2026-01-01T00:00:30Z"),
          rawTurn("turn_1", "2026-01-01T00:00:00Z"),
        ],
        pagination: { limit: 100, next_page_token: null, previous_page_token: null },
      });
    }) as typeof fetch,
    async () => {
      const client = createTrueForgeClient();
      const details = await client.listSessionToolCallDetails?.("sess_1");
      assert.deepEqual(
        details?.map((d) => d.id),
        ["call_1", "call_2", "call_9"],
        "earlier turn's calls come first and are not dropped by the later turn",
      );
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

test("refuses a TrueForge API key that is also exposed to the browser", () => {
  process.env.TRUEFORGE_URL = "https://trueforge.example.com";
  process.env.TRUEFORGE_API_KEY = "remote-secret";
  process.env.NEXT_PUBLIC_ACCIDENTAL_TRUEFORGE_KEY = "remote-secret";
  try {
    assert.throws(() => createTrueForgeClient(), /ships to the browser/);
  } finally {
    process.env.TRUEFORGE_URL = "http://localhost:8790";
    process.env.TRUEFORGE_API_KEY = "";
    delete process.env.NEXT_PUBLIC_ACCIDENTAL_TRUEFORGE_KEY;
  }
});

test("getTurn aborts the underlying request when the caller's signal aborts", async () => {
  // makeRequest.mjs combines the caller's AbortSignal into its own via anySignal(), so the
  // signal fetch actually receives is never the exact same object; asserting on .aborted
  // (and that abort propagates) is what proves the cancellation reached the request layer,
  // not just that the option was accepted and ignored.
  const controller = new AbortController();
  const stub: typeof fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", () => {
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      });
    })) as typeof fetch;

  await withFetch(stub, async () => {
    const client = createTrueForgeClient();
    const pending = client.getTurn("sess_1", "turn_1", { signal: controller.signal });
    controller.abort();
    await assert.rejects(() => pending);
  });
});

test("createSession aborts the underlying request when the caller's signal aborts", async () => {
  const controller = new AbortController();
  const stub: typeof fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", () => {
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      });
    })) as typeof fetch;

  await withFetch(stub, async () => {
    const client = createTrueForgeClient();
    const pending = client.createSession({ signal: controller.signal });
    controller.abort();
    await assert.rejects(() => pending);
  });
});

test("getTurn aborts pending-call event resolution with the caller's signal", async () => {
  const controller = new AbortController();
  let markEventRequestStarted!: () => void;
  const eventRequestStarted = new Promise<void>((resolve) => {
    markEventRequestStarted = resolve;
  });
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
  const stub: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes("/events")) return Promise.resolve(json(turnResponse));
    markEventRequestStarted();
    assert.ok(init?.signal, "event pagination must receive the caller's cancellation signal");
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  }) as typeof fetch;

  await withFetch(stub, async () => {
    const client = createTrueForgeClient();
    const pending = client.getTurn("sess_1", "turn_1", { signal: controller.signal });
    await eventRequestStarted;
    controller.abort(new Error("tick deadline exceeded"));
    await assert.rejects(() => pending, /aborted a request/i);
  });
});

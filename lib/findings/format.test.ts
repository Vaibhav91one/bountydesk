import assert from "node:assert/strict";
import test from "node:test";

import { describeFinding } from "./format";

test("a numbered run becomes a list, and the sentence after it does not join the list", () => {
  // The shape the agent actually writes: a label, the steps, then what it saw.
  const blocks = describeFinding(
    [
      "Steps to reproduce:",
      "1) GET /rest/products/search?q=apple (control) returned product rows only.",
      "2) GET /rest/products/search?q=qwert')) UNION SELECT id,email FROM Users--",
      "Observed behavior: the second request returned user emails and password hashes.",
    ].join("\n"),
  );

  assert.deepEqual(blocks, [
    { kind: "heading", text: "Steps to reproduce" },
    {
      kind: "steps",
      items: [
        "GET /rest/products/search?q=apple (control) returned product rows only.",
        "GET /rest/products/search?q=qwert')) UNION SELECT id,email FROM Users--",
      ],
    },
    {
      kind: "labelled",
      label: "Observed behavior",
      text: "the second request returned user emails and password hashes.",
    },
  ]);
});

test("an item wrapped onto an indented line stays one item, ordered or not", () => {
  assert.deepEqual(describeFinding("- send the payload\n    and read the response body"), [
    { kind: "bullets", items: ["send the payload and read the response body"] },
  ]);

  assert.deepEqual(describeFinding("1. send the payload\n    and read the response body"), [
    { kind: "steps", items: ["send the payload and read the response body"] },
  ]);
});

test("wrapped prose becomes one paragraph, and a blank line starts another", () => {
  const blocks = describeFinding("the endpoint is\nunauthenticated\n\nand it returns rows");

  assert.deepEqual(blocks, [
    { kind: "paragraph", text: "the endpoint is unauthenticated" },
    { kind: "paragraph", text: "and it returns rows" },
  ]);
});

test("a line that carries its own content after the label keeps both halves", () => {
  // Never a heading: a heading is a line that is nothing but a label, and treating this as one
  // would drop "full account takeover". It becomes a labelled block so the sentence survives
  // while its lead-in can still be given weight.
  assert.deepEqual(describeFinding("Impact: full account takeover"), [
    { kind: "labelled", label: "Impact", text: "full account takeover" },
  ]);
});

test("plain prose with no structure comes back as one paragraph", () => {
  assert.deepEqual(describeFinding("The search endpoint is injectable."), [
    { kind: "paragraph", text: "The search endpoint is injectable." },
  ]);
});

test("an empty description produces no blocks rather than an empty one", () => {
  assert.deepEqual(describeFinding("   \n\n  "), []);
});

test("a bulleted run is not renumbered as if it were steps", () => {
  // Bullets are not an order to follow, so they must not come back as "1. 2. 3.".
  assert.deepEqual(describeFinding("- no output encoding\n- no CSP\n- no HttpOnly flag"), [
    { kind: "bullets", items: ["no output encoding", "no CSP", "no HttpOnly flag"] },
  ]);
});

test("a bulleted run after a numbered one is a second list, not a continuation", () => {
  assert.deepEqual(describeFinding("1. visit /search\n2. observe the alert\n- affected: all users"), [
    { kind: "steps", items: ["visit /search", "observe the alert"] },
    { kind: "bullets", items: ["affected: all users"] },
  ]);
});

test("a fenced block keeps its content exactly, including what looks like a list", () => {
  const blocks = describeFinding("Request:\n```\nGET /search?q=1\n- not a bullet\n\nblank kept\n```");
  assert.deepEqual(blocks, [
    { kind: "heading", text: "Request" },
    { kind: "code", text: "GET /search?q=1\n- not a bullet\n\nblank kept" },
  ]);
});

test("a fence the agent never closed still ends cleanly at the last line", () => {
  assert.deepEqual(describeFinding("```\nGET /a\nGET /b"), [
    { kind: "code", text: "GET /a\nGET /b" },
  ]);
});

test("a label only counts at the start of a block, not mid-sentence", () => {
  // Lifting a label out of a sentence already in flight would reorder what the author wrote.
  assert.deepEqual(describeFinding("The request fails.\nReason: the token is unsigned"), [
    { kind: "paragraph", text: "The request fails. Reason: the token is unsigned" },
  ]);
});

test("a long lead-in is prose, not a label", () => {
  const long = "One-sentence severity justification that runs well past any label length: high";
  assert.deepEqual(describeFinding(long), [{ kind: "paragraph", text: long }]);
});

test("markup in a description stays text in every block kind", () => {
  // The agent can echo prompt-injection content off an untrusted target. This module promises
  // plain text out, and the callers render each block's text as text.
  const blocks = describeFinding(
    "Payload: <img src=x onerror=alert(1)>\n- <script>alert(2)</script>\n```\n<b>raw</b>\n```",
  );
  assert.deepEqual(blocks, [
    { kind: "labelled", label: "Payload", text: "<img src=x onerror=alert(1)>" },
    { kind: "bullets", items: ["<script>alert(2)</script>"] },
    { kind: "code", text: "<b>raw</b>" },
  ]);
});

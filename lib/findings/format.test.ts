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
      kind: "paragraph",
      text: "Observed behavior: the second request returned user emails and password hashes.",
    },
  ]);
});

test("a step wrapped onto an indented line stays one step", () => {
  const blocks = describeFinding("- send the payload\n    and read the response body");

  assert.deepEqual(blocks, [
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

test("a colon mid-sentence is not a heading", () => {
  // Only a line that is nothing but a label is a heading; this one carries its own content.
  assert.deepEqual(describeFinding("Impact: full account takeover"), [
    { kind: "paragraph", text: "Impact: full account takeover" },
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

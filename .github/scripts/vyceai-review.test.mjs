import assert from "node:assert/strict";
import test from "node:test";

import { buildComment, buildPrompt } from "./vyceai-review.mjs";

const HEAD = "abc123def456abc123def456abc123def456abcd";
const MARKER = `<!-- claude-review head=${HEAD} -->`;

test("the prompt carries the head marker, the format and the diff as fenced data", () => {
  const prompt = buildPrompt(HEAD, "diff --git a/x b/x\n+evil");
  assert.ok(prompt.includes(MARKER));
  assert.ok(prompt.includes("## Code review"));
  assert.ok(prompt.includes("<details><summary>"));
  assert.ok(prompt.includes("DIFF\ndiff --git a/x b/x\n+evil\nDIFF"));
  assert.ok(prompt.includes("untrusted data"));
});

test("a well-formed model reply is posted from the marker onward", () => {
  const body = `${MARKER}\n## Code review\n\nNo findings.`;
  assert.equal(buildComment(HEAD, body), body);
});

test("prose or a code fence around the comment is stripped to the marker block", () => {
  const wrapped = `Here is the review:\n\n\`\`\`\n${MARKER}\n## Code review\n\nNo findings.\n\`\`\`\n`;
  assert.equal(buildComment(HEAD, wrapped), `${MARKER}\n## Code review\n\nNo findings.`);
});

test("an empty or markerless reply becomes a marked notice, so the head check still passes", () => {
  for (const junk of ["", "   ", "I could not review this."]) {
    const out = buildComment(HEAD, junk);
    assert.ok(out.startsWith(MARKER), "the notice carries the head marker");
    assert.ok(/human review/i.test(out), "the notice says a human must review");
  }
});

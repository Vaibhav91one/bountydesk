import assert from "node:assert/strict";
import test from "node:test";

process.env.REVIEWER_GITHUB_IDS = "4242";

import { parseReproduceCommand, reproductionRequested } from "./commands";

test("parseReproduceCommand matches a bare command and its case and spacing variants", () => {
  for (const body of ["/reproduce", "/Reproduce", "/REPRODUCE", "   /reproduce", "\t/reproduce"]) {
    assert.equal(parseReproduceCommand(body).matched, true, body);
  }
});

test("parseReproduceCommand matches the command on its own line inside a longer body", () => {
  const body = "Here is what I found.\n\n/reproduce\n\nMore context below.";
  assert.equal(parseReproduceCommand(body).matched, true);
});

test("parseReproduceCommand captures trailing args but still matches", () => {
  const parsed = parseReproduceCommand("/reproduce --profile foo");
  assert.equal(parsed.matched, true);
  assert.equal(parsed.args, "--profile foo");
});

test("parseReproduceCommand ignores the command mid-sentence or as a bare mention", () => {
  for (const body of ["please /reproduce this for me", "the /reproduce label", "reproduce", "/reproducer"]) {
    assert.equal(parseReproduceCommand(body).matched, false, body);
  }
});

test("parseReproduceCommand treats an empty or missing body as no command", () => {
  assert.equal(parseReproduceCommand(null).matched, false);
  assert.equal(parseReproduceCommand(undefined).matched, false);
  assert.equal(parseReproduceCommand("").matched, false);
});

test("reproductionRequested needs both the command and a reviewer actor", () => {
  assert.equal(reproductionRequested("/reproduce", 4242), true);
  assert.equal(reproductionRequested("/reproduce", 9999), false, "off the allowlist");
  assert.equal(reproductionRequested("no command here", 4242), false, "no command");
  assert.equal(reproductionRequested("/reproduce", undefined), false, "no sender id");
});

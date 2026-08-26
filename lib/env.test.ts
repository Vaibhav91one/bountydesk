import assert from "node:assert/strict";
import test from "node:test";

import { requireSecret } from "./env";

test("a missing secret is fatal", () => {
  delete process.env.BD_TEST_SECRET;
  assert.throws(() => requireSecret("BD_TEST_SECRET"), /is not set/);
});

test("a blank secret counts as missing", () => {
  process.env.BD_TEST_SECRET = "   ";
  assert.throws(() => requireSecret("BD_TEST_SECRET"), /is not set/);
  delete process.env.BD_TEST_SECRET;
});

test("a secret read from a client-visible name is refused", () => {
  process.env.NEXT_PUBLIC_BD_TEST = "value";
  assert.throws(() => requireSecret("NEXT_PUBLIC_BD_TEST"), /client-visible/);
  delete process.env.NEXT_PUBLIC_BD_TEST;
});

test("a secret whose value also sits in a public variable is refused", () => {
  process.env.BD_TEST_SECRET = "shared-value";
  process.env.NEXT_PUBLIC_BD_TEST = "shared-value";

  assert.throws(() => requireSecret("BD_TEST_SECRET"), /ships to the browser/);

  delete process.env.BD_TEST_SECRET;
  delete process.env.NEXT_PUBLIC_BD_TEST;
});

test("a secret that only exists server-side is returned", () => {
  process.env.BD_TEST_SECRET = "  server-only  ";
  assert.equal(requireSecret("BD_TEST_SECRET"), "server-only");
  delete process.env.BD_TEST_SECRET;
});

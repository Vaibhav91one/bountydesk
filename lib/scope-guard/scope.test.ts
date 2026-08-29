import assert from "node:assert/strict";
import test from "node:test";

/**
 * Deterministic unit tests for Scope policy logic (no network, no database). DNS is injected,
 * and persistence is an in-memory sink, so every rebinding / mixed-answer / NXDOMAIN /
 * quarantine branch is exercised without a live Postgres connection - the point of keeping
 * the persistence seam separate from lib/scope-guard/scope-profile.ts.
 *
 * Ported from Sentinel's mcp/scope-guard/scripts/scope.test.mjs (13 adversarial cases),
 * translated from node:test + a JSON-file Scope to node:test + TypeScript against the
 * injectable-state Scope in this package.
 */
import { defaultScopeState, sanitizeScopeState, Scope, type ScopeState } from "./scope";

type Lookup = (host: string) => Promise<{ address: string }[]>;

/** Builds a Scope over an in-memory state, recording every persisted snapshot so a test can
 * inspect what would have been written back to target_profile.scope_rules. */
function makeScope(lookup?: Lookup): { scope: Scope; saved: ScopeState[] } {
  const saved: ScopeState[] = [];
  const scope = new Scope(defaultScopeState(), lookup, (state) => {
    saved.push(state);
  });
  return { scope, saved };
}

async function scopeWithAllow(allow: string[], lookup?: Lookup): Promise<Scope> {
  const { scope } = makeScope(lookup);
  for (const e of allow) assert.equal(await scope.add(e), null);
  return scope;
}

test("public hostname resolving to loopback is denied as rebinding", async () => {
  const s = await scopeWithAllow(["localtest.me"], async () => [{ address: "127.0.0.1" }, { address: "::1" }]);
  const r = await s.check("http://localtest.me:3000");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /rebinding/);
});

test("public hostname resolving to metadata address is hard-denied", async () => {
  const s = await scopeWithAllow(["rebind.example"], async () => [{ address: "169.254.169.254" }]);
  const r = await s.check("http://rebind.example");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /metadata/i);
});

test("mixed public+private answers are denied (fail closed)", async () => {
  const s = await scopeWithAllow(["dual.example"], async () => [{ address: "93.184.216.34" }, { address: "10.0.0.5" }]);
  const r = await s.check("http://dual.example");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /private address/);
});

test("NXDOMAIN fails closed even when scoped", async () => {
  const s = await scopeWithAllow(["gone.example"], async () => {
    throw Object.assign(new Error("no such record"), { code: "ENOTFOUND" });
  });
  const r = await s.check("http://gone.example");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /fail-closed/);
});

test("empty DNS answer fails closed even when scoped", async () => {
  const s = await scopeWithAllow(["empty.example"], async () => []);
  const r = await s.check("http://empty.example");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /zero usable addresses/);
});

test("internally-scoped name resolving public is denied as class mismatch", async () => {
  const s = await scopeWithAllow(["intranet.local"], async () => [{ address: "93.184.216.34" }]);
  const r = await s.check("http://intranet.local");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /class mismatch/);
});

test("consistent resolutions are allowed", async () => {
  const s = await scopeWithAllow(["ok.example"], async () => [{ address: "93.184.216.34" }]);
  const r = await s.check("http://ok.example");
  assert.equal(r.allowed, true);
});

test("IP literals and CIDR entries skip DNS entirely", async () => {
  let called = 0;
  const s = await scopeWithAllow(["10.50.77.0/24"], async () => {
    called++;
    return [{ address: "127.0.0.1" }];
  });
  const r = await s.check("http://10.50.77.9:8080");
  assert.equal(r.allowed, true);
  assert.equal(called, 0, "DNS must not be consulted for CIDR matches");
});

test("canonicalization: expanded IPv6 loopback matches ::1 entry", async () => {
  const { scope } = makeScope(); // fresh state -> default allowlist includes canonical "::1"
  const dupErr = await scope.add("::1");
  assert.match(dupErr ?? "", /already scoped/);
  const r = await scope.check("http://[0:0:0:0:0:0:0:1]:3000");
  assert.equal(r.allowed, true);
  assert.equal(r.matched, "::1");
});

test("mapped-v6 literals are judged by embedded IPv4", async () => {
  const { scope } = makeScope();
  assert.match((await scope.add("::ffff:169.254.169.254")) ?? "", /hard-denied/);
  const r = await scope.check("http://[::ffff:a9fe:a9fe]");
  assert.equal(r.allowed, false);
});

test("reserved v4 literals are refused at add time", async () => {
  const { scope } = makeScope();
  for (const entry of ["224.0.0.1", "192.0.2.1", "192.88.99.5", "100.64.1.2", "0.0.0.0"]) {
    const err = await scope.add(entry);
    assert.match(err ?? "", /hard-denied/, `${entry} should be refused`);
  }
});

test("CIDR overlap with reserved space is refused", async () => {
  const { scope } = makeScope();
  for (const entry of ["169.254.0.0/16", "192.88.99.0/24", "240.0.0.0/4"]) {
    const err = await scope.add(entry);
    assert.match(err ?? "", /hard-denied/, `${entry} should be refused`);
  }
  const ok = await scope.add("203.0.113.0/24");
  // TEST-NET-3 is classified reserved via literal rules; CIDR form must refuse too
  assert.match(ok ?? "", /hard-denied|TEST|refused/, `203.0.113.0/24 unexpectedly accepted: ${ok}`);
});

test("persisted scope state is sanitized on load (quarantine bypass entries)", () => {
  const raw = {
    allow: ["localhost", "0.0.0.0/0", "169.254.1.1", "::1", "not a real entry!!", "10.50.77.0/24"],
  };
  const { state, rejected } = sanitizeScopeState(raw);

  assert.ok(state.allow.includes("localhost"), "valid entry kept");
  assert.ok(state.allow.includes("::1"), "valid v6 entry kept");
  assert.ok(state.allow.includes("10.50.77.0/24"), "valid private CIDR kept");
  assert.equal(state.allow.includes("0.0.0.0/0"), false, "broad CIDR quarantined");
  assert.equal(state.allow.includes("169.254.1.1"), false, "link-local literal quarantined");
  assert.equal(state.allow.includes("not a real entry!!"), false, "garbage entry quarantined");
  assert.equal(rejected.length, 3, "exactly the three invalid entries are reported");

  // Feeding the sanitized state back through Scope must not re-trigger quarantine: it is
  // already valid.
  const { state: reSanitized, rejected: reRejected } = sanitizeScopeState(state);
  assert.deepEqual(reSanitized.allow.sort(), state.allow.sort());
  assert.equal(reRejected.length, 0);
});

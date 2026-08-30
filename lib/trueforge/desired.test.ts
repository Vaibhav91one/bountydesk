import assert from "node:assert/strict";
import test from "node:test";

import { desiredSkills, reconcile, resolveApiKey } from "./desired";

/**
 * Drift labelling is the only logic in the harness screen that is not a passthrough to the
 * SDK, and it fails quietly: a skill mislabelled `unmanaged` renders without controls and an
 * operator reads that as "someone else owns this" rather than "the apply never ran". No
 * Postgres and no fetch faking, because neither is involved.
 */

/**
 * The eleven skills another project left on the shared harness. They are the reason the
 * screen reports drift instead of reconciling it: there is no DELETE for a skill, and
 * offering one would be offering to break Sentinel.
 */
const SENTINEL_SKILLS = [
  "sentinel-api-security",
  "sentinel-challenges",
  "sentinel-cve-lab-construction",
  "sentinel-dast",
  "sentinel-demo-targets",
  "sentinel-firmware",
  "sentinel-mobile",
  "sentinel-payloads",
  "sentinel-recon",
  "sentinel-triage",
  "sentinel-validation",
];

test("reconcile labels applied skills managed, unapplied ones missing, and other projects' unmanaged", () => {
  const desired = desiredSkills();
  assert.ok(desired.length > 1, "expected the repository to declare several skills");

  // Everything declared except bountydesk-recon, so the missing arm is exercised against a
  // real skill name rather than an invented one.
  const applied = desired.map((skill) => skill.name).filter((name) => name !== "bountydesk-recon");
  const live = [...applied, ...SENTINEL_SKILLS].map((name) => ({ name }));

  const rows = reconcile(live, desired).map((row) => [row.name, row.drift]);

  assert.deepEqual(rows, [
    ...applied.map((name) => [name, "managed"]).sort(([a], [b]) => a.localeCompare(b)),
    ["bountydesk-recon", "missing"],
    ...SENTINEL_SKILLS.map((name) => [name, "unmanaged"]),
  ]);
});

test("reconcile carries both sides through, so a row can render what the server holds", () => {
  const [managed, missing, unmanaged] = reconcile(
    [{ name: "a", ref: "live" }, { name: "c", ref: "live" }],
    [{ name: "a", ref: "desired" }, { name: "b", ref: "desired" }],
  );

  assert.deepEqual(managed, {
    name: "a",
    drift: "managed",
    live: { name: "a", ref: "live" },
    desired: { name: "a", ref: "desired" },
  });
  assert.deepEqual(missing, {
    name: "b",
    drift: "missing",
    live: null,
    desired: { name: "b", ref: "desired" },
  });
  assert.deepEqual(unmanaged, {
    name: "c",
    drift: "unmanaged",
    live: { name: "c", ref: "live" },
    desired: null,
  });
});

test("an untouched key field replays the stored secret and a typed one rotates it", () => {
  // The harness reads a value containing ***REDACTED*** as "keep what you have". Getting this
  // backwards overwrites a working credential with the redaction string and reports success.
  assert.equal(resolveApiKey("", "sk--***REDACTED***-444"), "sk--***REDACTED***-444");
  assert.equal(resolveApiKey("  ", "sk--***REDACTED***-444"), "sk--***REDACTED***-444");
  assert.equal(resolveApiKey("sk-live-new", "sk--***REDACTED***-444"), "sk-live-new");
  assert.equal(resolveApiKey("sk-live-new", undefined), "sk-live-new");
  assert.equal(resolveApiKey("", undefined), null);
});

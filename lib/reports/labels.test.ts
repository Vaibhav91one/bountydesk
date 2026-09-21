import assert from "node:assert/strict";
import test from "node:test";

import { ageLabelFor } from "./queue-view";
import { recheckStatusLabel, shouldShowOutcomeBadge } from "./labels";

test("a current outcome still badges, except ANALYSIS_ONLY twice", () => {
  assert.equal(shouldShowOutcomeBadge("REPRODUCING", "NOT_REPRODUCED"), true);
  assert.equal(shouldShowOutcomeBadge("AWAITING_APPROVAL", "REPRODUCED"), true);
  assert.equal(shouldShowOutcomeBadge("ANALYSIS_ONLY", "ANALYSIS_ONLY"), false);
  assert.equal(shouldShowOutcomeBadge("TRIAGING", null), false);
});

test("a superseded verdict never badges, whatever the state and outcome", () => {
  // The board case: a re-check moved the report to REPRODUCING while the newest row is
  // still the superseded rev 1. Showing it would put "Not reproduced" beside "Reproducing".
  assert.equal(
    shouldShowOutcomeBadge("REPRODUCING", "NOT_REPRODUCED", { superseded: true }),
    false,
  );
  assert.equal(
    shouldShowOutcomeBadge("AWAITING_APPROVAL", "REPRODUCED", { superseded: true }),
    false,
  );
  // The flag off changes nothing, so callers that do not track supersession keep working.
  assert.equal(
    shouldShowOutcomeBadge("REPRODUCING", "NOT_REPRODUCED", { superseded: false }),
    true,
  );
  assert.equal(shouldShowOutcomeBadge("REPRODUCING", "NOT_REPRODUCED"), true);
});

test("a re-check run maps to its card status, anything else to nothing", () => {
  assert.equal(recheckStatusLabel("PENDING", true), "Re-check queued");
  assert.equal(recheckStatusLabel("RUNNING", true), "Re-check running");
  assert.equal(recheckStatusLabel("ERROR", true), "Re-check failed");
  // A finished, cancelled or superseded parent run leaves the generic state label in charge.
  for (const status of ["AWAITING_APPROVAL", "SUPERSEDED", "DONE", "CANCELLED", null, undefined]) {
    assert.equal(recheckStatusLabel(status, true), null, `${status} should fall through`);
  }
  // Without a superseded verdict there is no re-check to report, whatever runs exist.
  for (const status of ["PENDING", "RUNNING", "ERROR", null]) {
    assert.equal(recheckStatusLabel(status, false), null, `${status} should fall through`);
  }
});

test("the server-cut age stays coarse at the same boundaries the board used", () => {
  const now = new Date("2026-08-31T10:00:00.000Z").getTime();
  assert.equal(ageLabelFor(new Date(now - 30_000), now), "now");
  assert.equal(ageLabelFor(new Date(now - 3 * 60_000), now), "3m");
  assert.equal(ageLabelFor(new Date(now - 59 * 60_000), now), "59m");
  assert.equal(ageLabelFor(new Date(now - 3 * 3_600_000), now), "3h");
  assert.equal(ageLabelFor(new Date(now - 3 * 86_400_000), now), "3d");
  // ISO strings cross the wire, so the helper must accept them as well as Dates.
  assert.equal(ageLabelFor("2026-08-31T09:00:00.000Z", now), "1h");
});

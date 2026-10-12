import assert from "node:assert/strict";
import test from "node:test";

import { deliveryFailureReason, targetPort, targetVersion, topSeverity } from "./fields";

test("topSeverity picks the worst known level, capitalised, and ignores the rest", () => {
  assert.equal(topSeverity({ findings: [{ severity: "medium" }, { severity: "HIGH" }, { severity: "low" }] }), "High");
  assert.equal(topSeverity({ findings: [{ severity: "info" }] }), "Info");
  assert.equal(topSeverity({ findings: [{ severity: "catastrophic" }, null, {}] }), null);
  assert.equal(topSeverity({ findings: [] }), null);
  assert.equal(topSeverity("a bare reason string"), null);
  assert.equal(topSeverity(null), null);
});

test("targetVersion reads the name suffix, then the snapshot tag, else null", () => {
  assert.equal(targetVersion("juice-shop-v17.3.0", {}), "v17.3.0");
  assert.equal(
    targetVersion("dvwa", { provisioning: { snapshotImageRefOverride: "ghcr.io/x/dvwa:v1.9-bountydesk-sandbox" } }),
    "v1.9",
  );
  assert.equal(targetVersion("dvwa", { provisioning: { snapshotImageRefOverride: "ghcr.io/x/dvwa:latest" } }), null);
  assert.equal(targetVersion("plain", null), null);
  assert.equal(targetVersion(null, {}), null);
});

test("targetPort comes from baseUrl, with scheme defaults, else null", () => {
  assert.equal(targetPort({ baseUrl: "http://localhost:3000" }), 3000);
  assert.equal(targetPort({ baseUrl: "http://localhost" }), 80);
  assert.equal(targetPort({ baseUrl: "https://example.test" }), 443);
  assert.equal(targetPort({}), null);
  assert.equal(targetPort(null), null);
});

test("deliveryFailureReason maps to a fixed set and never echoes the stored text", () => {
  const f = (lastError: string | null, requiresHumanReview = false, state: string | null = "FAILED") =>
    deliveryFailureReason({ state, lastError, requiresHumanReview });
  assert.equal(f("boom ghp_TOKEN https://x.test/y"), "Delivery failed");
  assert.equal(f(null), "Delivery failed");
  assert.equal(f("acme/app is no longer connected"), "Repository no longer connected");
  assert.equal(f("content hash mismatch for verdict 1"), "Approved text no longer matches");
  assert.equal(f("x", true), "Held for human review");
  assert.equal(f("boom", false, "SENT"), null);
  assert.equal(f("boom", false, null), null);
});

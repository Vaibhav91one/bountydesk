import assert from "node:assert/strict";
import test from "node:test";

import {
  EGRESS_DENIAL_BODY,
  classifyNetworkProbe,
  networkProbeCommand,
  parseNetworkProbeOutput,
  parseToolAvailability,
  readProbeConfig,
  toolCheckCommand,
} from "./capability-probe";

const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE_REF = `ghcr.io/vaibhav91one/juice-shop@${DIGEST}`;
const ENV = { DAYTONA_API_KEY: "dtn_live_key_shape_for_tests" };

test("probe config accepts an explicit snapshot and digest-pinned image ref", () => {
  const config = readProbeConfig(
    ["--snapshot", "snapshot-123", "--expected-image-ref", IMAGE_REF],
    ENV,
  );

  assert.deepEqual(config, {
    snapshot: "snapshot-123",
    expectedImageRef: IMAGE_REF,
    ttlMinutes: 10,
  });
  assert.equal("DAYTONA_API_KEY" in config, false);
});

test("probe config can compose the expected image ref from an explicit image name and digest", () => {
  const config = readProbeConfig(
    [
      "--snapshot=snapshot-123",
      "--image-name=ghcr.io/vaibhav91one/juice-shop",
      "--expected-image-digest",
      DIGEST,
      "--allowed-snapshot-image-ref",
      "ghcr.io/vaibhav91one/juice-shop:v17.3.0-bountydesk-sandbox",
      "--ttl-minutes",
      "7",
    ],
    ENV,
  );

  assert.equal(config.expectedImageRef, IMAGE_REF);
  assert.equal(
    config.allowedSnapshotImageRef,
    "ghcr.io/vaibhav91one/juice-shop:v17.3.0-bountydesk-sandbox",
  );
  assert.equal(config.ttlMinutes, 7);
});

test("probe config refuses missing secrets and placeholders before any live call", () => {
  assert.throws(
    () => readProbeConfig(["--snapshot", "snapshot-123", "--expected-image-ref", IMAGE_REF], {}),
    /DAYTONA_API_KEY is required/,
  );
  assert.throws(
    () =>
      readProbeConfig(["--snapshot", "snapshot-123", "--expected-image-ref", IMAGE_REF], {
        DAYTONA_API_KEY: "dtn_not_a_real_one",
      }),
    /DAYTONA_API_KEY is still a placeholder/,
  );
  assert.throws(
    () =>
      readProbeConfig(["--snapshot", "<immutable-daytona-snapshot-id>", "--expected-image-ref", IMAGE_REF], ENV),
    /snapshot is still a placeholder/,
  );
});

test("probe config refuses mutable or malformed expected image input", () => {
  assert.throws(
    () =>
      readProbeConfig(
        ["--snapshot", "snapshot-123", "--expected-image-ref", "ghcr.io/vaibhav91one/juice-shop:latest"],
        ENV,
      ),
    /expected-image-ref must be/,
  );
  assert.throws(
    () =>
      readProbeConfig(
        [
          "--snapshot",
          "snapshot-123",
          "--image-name",
          "ghcr.io/vaibhav91one/juice-shop",
          "--expected-image-digest",
          `sha256:${"g".repeat(64)}`,
        ],
        ENV,
      ),
    /expected-image-digest must be/,
  );
});

test("tool output parser reports missing tools explicitly", () => {
  const parsed = parseToolAvailability(
    "TOOL sh ok /usr/bin/sh\nTOOL curl missing\nTOOL npm ok /usr/local/bin/npm\n",
  );

  assert.deepEqual(parsed, [
    { tool: "sh", ok: true, path: "/usr/bin/sh" },
    { tool: "curl", ok: false, path: null },
    { tool: "npm", ok: true, path: "/usr/local/bin/npm" },
  ]);
});

test("tool check command emits stable TOOL lines", () => {
  const command = toolCheckCommand(["sh", "curl"]);

  assert.match(command, /TOOL %s ok %s/);
  assert.match(command, /TOOL %s missing/);
  assert.match(command, /'sh'/);
  assert.match(command, /'curl'/);
});

test("network probe parser and classifier accept Daytona's interception response as blocked", () => {
  const parsed = parseNetworkProbeOutput({
    exitCode: 0,
    result: `PROBE curl_exit=0 status=403\nBODY ${EGRESS_DENIAL_BODY}\nERR \n`,
  });

  assert.deepEqual(classifyNetworkProbe(parsed), {
    blocked: true,
    reason: "daytona_interception_proxy",
  });
});

test("network probe parser and classifier accept transport failure as blocked", () => {
  const parsed = parseNetworkProbeOutput({
    exitCode: 0,
    result: "PROBE curl_exit=28 status=000\nBODY \nERR Resolving timed out\n",
  });

  assert.deepEqual(classifyNetworkProbe(parsed), {
    blocked: true,
    reason: "transport_failure",
  });
});

test("network probe classifier treats ordinary HTTP answers as reachable", () => {
  const parsed = parseNetworkProbeOutput({
    exitCode: 0,
    result: "PROBE curl_exit=0 status=401\nBODY metadata service requires token\nERR \n",
  });

  assert.deepEqual(classifyNetworkProbe(parsed), {
    blocked: false,
    reason: "reachable",
  });
});

test("network probe command includes fixed URL and metadata header without leaking credentials", () => {
  const command = networkProbeCommand({
    name: "gce_metadata",
    kind: "metadata",
    url: "http://169.254.169.254/computeMetadata/v1/",
    header: "Metadata-Flavor: Google",
  });

  assert.match(command, /169\.254\.169\.254/);
  assert.match(command, /Metadata-Flavor: Google/);
  assert.doesNotMatch(command, /DAYTONA_API_KEY|Bearer|dtn_/);
});

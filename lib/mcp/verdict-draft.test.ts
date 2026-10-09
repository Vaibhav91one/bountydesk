import assert from "node:assert/strict";
import test from "node:test";

import { findingSchema } from "./verdict-draft";

const BASE = { title: "Reflected XSS in search", severity: "high" as const, description: "d", evidenceRef: "ref-1" };

test("a finding with no cvssVector is still valid; the field is optional", () => {
  const parsed = findingSchema.safeParse(BASE);
  assert.ok(parsed.success);
});

test("a well-formed CVSS 3.1 base vector is accepted", () => {
  const parsed = findingSchema.safeParse({
    ...BASE,
    cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
  });
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});

test("a base vector with trailing temporal/environmental metrics is still accepted", () => {
  const parsed = findingSchema.safeParse({
    ...BASE,
    cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:P/RL:O/RC:C",
  });
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});

test("a malformed or made-up vector is refused, not stored looking real", () => {
  for (const bad of [
    "CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", // wrong version
    "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", // missing the CVSS:3.1/ prefix
    "CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", // AV has no X value
    "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H", // missing the required A metric
    "high", // not a vector at all
  ]) {
    const parsed = findingSchema.safeParse({ ...BASE, cvssVector: bad });
    assert.equal(parsed.success, false, `"${bad}" should have been refused`);
  }
});

test("a vector padded with repeated extension segments past the length cap is refused", () => {
  // The regex's trailing group repeats without limit on its own, so a value built from enough
  // extension segments (each individually regex-legal) could still match it; the separate
  // .max(200) is what actually bounds this.
  const padding = "/XX:00".repeat(50);
  const padded = `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H${padding}`;
  assert.ok(padded.length > 200);
  const parsed = findingSchema.safeParse({ ...BASE, cvssVector: padded });
  assert.equal(parsed.success, false);
});

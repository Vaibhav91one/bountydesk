import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { codeMatches, hashCode } from "./otp";

process.env.OTP_HMAC_KEY = "test-otp-key";

const legacy = (code: string) => crypto.createHash("sha256").update(code).digest("hex");

test("hashCode is keyed, so it differs from the unkeyed SHA-256", () => {
  assert.notEqual(hashCode("123456"), legacy("123456"));
  assert.ok(codeMatches(hashCode("123456"), "123456"));
});

test("a legacy unkeyed hash still verifies", () => {
  assert.ok(codeMatches(legacy("123456"), "123456"));
});

test("a wrong code is refused in both forms", () => {
  assert.equal(codeMatches(hashCode("123456"), "654321"), false);
  assert.equal(codeMatches(legacy("123456"), "654321"), false);
});

test("a missing key refuses to hash or verify", () => {
  const saved = process.env.OTP_HMAC_KEY;
  delete process.env.OTP_HMAC_KEY;
  try {
    assert.throws(() => hashCode("123456"), /OTP_HMAC_KEY is not set/);
    assert.throws(() => codeMatches(legacy("123456"), "123456"), /OTP_HMAC_KEY is not set/);
  } finally {
    process.env.OTP_HMAC_KEY = saved;
  }
});

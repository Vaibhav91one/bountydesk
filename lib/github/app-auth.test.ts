import { createVerify, generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

// Module load order matters: lib/env.ts and lib/github/app-auth.ts read process.env at call
// time, not at import time, but setting these before the import (rather than inside a test)
// matches the pattern lib/sandbox/daytona.test.ts uses and keeps every test in this file
// working against the same real keypair by default.
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

process.env.GITHUB_APP_ID = "123456";
process.env.GITHUB_APP_PRIVATE_KEY_BASE64 =
  Buffer.from(privateKey).toString("base64");

import { mintInstallationToken, signAppJwt } from "./app-auth";

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

test("signAppJwt sets iss, and exp is exactly 600s past a backdated iat", () => {
  const now = new Date();
  const jwt = signAppJwt(now);
  const [headerB64, payloadB64, signatureB64] = jwt.split(".");

  assert.deepEqual(decodeSegment(headerB64), { alg: "RS256", typ: "JWT" });

  const payload = decodeSegment(payloadB64) as {
    iat: number;
    exp: number;
    iss: string;
  };
  assert.equal(payload.iss, "123456");
  assert.equal(payload.exp - payload.iat, 600);

  const nowSeconds = Math.floor(now.getTime() / 1000);
  // Backdated by 60s for clock drift; allow a few seconds of test-run slack either side.
  assert.ok(
    payload.iat <= nowSeconds - 55 && payload.iat >= nowSeconds - 65,
    `expected iat ~60s before ${nowSeconds}, got ${payload.iat}`,
  );

  assert.ok(signatureB64.length > 0);
});

test("the signature verifies as RS256 against the matching public key", () => {
  const jwt = signAppJwt();
  const [headerB64, payloadB64, signatureB64] = jwt.split(".");

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  assert.equal(verifier.verify(publicKey, signatureB64, "base64url"), true);
});

test("a malformed GitHub App id is rejected before signing", () => {
  const original = process.env.GITHUB_APP_ID;
  process.env.GITHUB_APP_ID = "not-an-app-id";
  try {
    assert.throws(() => signAppJwt(), /positive integer/);
  } finally {
    process.env.GITHUB_APP_ID = original;
  }
});

test("a key that is valid base64 but not a PEM block fails before any network call", async () => {
  const original = process.env.GITHUB_APP_PRIVATE_KEY_BASE64;
  process.env.GITHUB_APP_PRIVATE_KEY_BASE64 =
    Buffer.from("not a key").toString("base64");

  const stub = (async () => {
    throw new Error("fetch must not run when the private key is malformed");
  }) as typeof fetch;

  try {
    await assert.rejects(mintInstallationToken(1, 1, { fetchImpl: stub }));
  } finally {
    process.env.GITHUB_APP_PRIVATE_KEY_BASE64 = original;
  }
});

test("mintInstallationToken sends a scoped request and parses expires_at", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;

  const stub = (async (url: unknown, init?: RequestInit) => {
    seenUrl = String(url);
    seenInit = init;
    return new Response(
      JSON.stringify({
        token: "ghs_minted",
        expires_at: "2026-08-27T12:00:00Z",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const result = await mintInstallationToken(42, 99, { fetchImpl: stub });

  assert.equal(
    seenUrl,
    "https://api.github.com/app/installations/42/access_tokens",
  );
  assert.deepEqual(JSON.parse(seenInit?.body as string), {
    repository_ids: [99],
  });

  const headers = seenInit?.headers as Record<string, string>;
  assert.match(headers.authorization, /^Bearer ey/);
  assert.equal(headers["x-github-api-version"], "2022-11-28");

  assert.deepEqual(result, {
    token: "ghs_minted",
    expiresAt: "2026-08-27T12:00:00Z",
  });
});

test("mintInstallationToken rejects a malformed successful response", async () => {
  const stub = (async () =>
    new Response(JSON.stringify({ token: "", expires_at: "not-a-date" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  await assert.rejects(
    mintInstallationToken(42, 99, { fetchImpl: stub }),
    /malformed installation token response/,
  );
});

test("a 422 from GitHub is thrown with the status in the message", async () => {
  const stub = (async () =>
    new Response("Validation failed", { status: 422 })) as typeof fetch;
  await assert.rejects(mintInstallationToken(1, 1, { fetchImpl: stub }), /422/);
});

test("a 401 from GitHub is thrown with the status in the message", async () => {
  const stub = (async () =>
    new Response("Bad credentials", { status: 401 })) as typeof fetch;
  await assert.rejects(mintInstallationToken(1, 1, { fetchImpl: stub }), /401/);
});

test("installationId 0, -1 and 1.5 all throw before the stub is called", async () => {
  const stub = (async () => {
    throw new Error("fetch must not run for an invalid installationId");
  }) as typeof fetch;

  for (const bad of [0, -1, 1.5]) {
    await assert.rejects(
      mintInstallationToken(bad, 1, { fetchImpl: stub }),
      String(bad),
    );
  }
});

test("neither the private key nor a minted token ever reach console output", async () => {
  const calls: unknown[][] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => calls.push(args);
  console.error = (...args: unknown[]) => calls.push(args);
  console.warn = (...args: unknown[]) => calls.push(args);

  try {
    const okStub = (async () =>
      new Response(
        JSON.stringify({
          token: "ghs_should_never_be_logged",
          expires_at: "2026-08-27T12:00:00Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    await mintInstallationToken(1, 1, { fetchImpl: okStub });

    const failStub = (async () =>
      new Response("nope", { status: 401 })) as typeof fetch;
    await assert.rejects(mintInstallationToken(1, 1, { fetchImpl: failStub }));
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }

  const serialised = JSON.stringify(calls);
  assert.equal(serialised.includes("ghs_should_never_be_logged"), false);
  assert.equal(serialised.includes(privateKey), false);
});

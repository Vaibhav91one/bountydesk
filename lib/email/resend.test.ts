import assert from "node:assert/strict";
import test from "node:test";

import { fetchInboundBody, fetchRawHeaders } from "./resend";

const realFetch = globalThis.fetch;

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

test("fetchInboundBody calls the receiving endpoint with auth and returns the text body", async () => {
  process.env.RESEND_API_KEY = "re_test_key";
  let seenUrl = "";
  let seenAuth: string | null = null;
  stubFetch((url, init) => {
    seenUrl = url;
    seenAuth = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify({ text: "steps to reproduce", html: "<p>steps</p>" }), { status: 200 });
  });
  try {
    const body = await fetchInboundBody("abc-123");
    assert.equal(seenUrl, "https://api.resend.com/emails/receiving/abc-123");
    assert.equal(seenAuth, "Bearer re_test_key");
    assert.equal(body.text, "steps to reproduce");
    assert.equal(body.html, "<p>steps</p>");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchInboundBody throws on a non-2xx so the job retries", async () => {
  process.env.RESEND_API_KEY = "re_test_key";
  stubFetch(() => new Response("nope", { status: 502, statusText: "Bad Gateway" }));
  try {
    await assert.rejects(fetchInboundBody("abc-123"), /502/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchInboundBody rethrows a network failure with context so the retry is legible", async () => {
  process.env.RESEND_API_KEY = "re_test_key";
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    await assert.rejects(fetchInboundBody("abc-123"), /abc-123 failed to connect/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchInboundBody rethrows unparseable JSON with context", async () => {
  process.env.RESEND_API_KEY = "re_test_key";
  stubFetch(() => new Response("<html>not json</html>", { status: 200 }));
  try {
    await assert.rejects(fetchInboundBody("abc-123"), /abc-123 returned unparseable JSON/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchInboundBody tolerates a missing text or html field", async () => {
  process.env.RESEND_API_KEY = "re_test_key";
  stubFetch(() => new Response(JSON.stringify({ text: "only text" }), { status: 200 }));
  try {
    const body = await fetchInboundBody("abc-123");
    assert.equal(body.text, "only text");
    assert.equal(body.html, "");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchInboundBody reads SPF, DKIM and the message size, and a missing verdict fails closed", async () => {
  process.env.RESEND_API_KEY = "re_test_key";
  stubFetch(
    () =>
      new Response(
        JSON.stringify({
          text: "abc",
          html: "<p>abc</p>",
          authentication: { spf: "pass", dkim: "gray", dmarc: "pass" },
          attachments: [{ size: 1000 }, { size: "not a number" }, null],
        }),
        { status: 200 },
      ),
  );
  try {
    const body = await fetchInboundBody("abc-123");
    assert.equal(body.spf, "pass");
    assert.equal(body.dkim, "gray");
    assert.equal(body.sizeBytes, 3 + 10 + 1000);
  } finally {
    globalThis.fetch = realFetch;
  }

  stubFetch(() => new Response(JSON.stringify({ text: "x", authentication: { spf: "PASS!" } }), { status: 200 }));
  try {
    const body = await fetchInboundBody("abc-123");
    assert.equal(body.spf, "unknown");
    assert.equal(body.dkim, "unknown");
    assert.equal(body.rawUrl, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchRawHeaders returns the header block, sends no API key, and stops before the body", async () => {
  process.env.RESEND_API_KEY = "re_test_key";
  let seenAuth: string | null = "unset";
  stubFetch((_url, init) => {
    seenAuth = new Headers(init?.headers).get("authorization");
    return new Response("X-SES-RECEIPT: a\r\nFrom: <a@b.test>\r\n\r\n" + "body ".repeat(50_000), { status: 200 });
  });
  try {
    const headers = await fetchRawHeaders("https://cdn.test/raw");
    assert.equal(seenAuth, null, "the signed URL needs no credential, so none is sent");
    assert.ok(headers.startsWith("X-SES-RECEIPT: a"));
    assert.ok(headers.length < 64 * 1024);
  } finally {
    globalThis.fetch = realFetch;
  }

  stubFetch(() => new Response("gone", { status: 403 }));
  try {
    await assert.rejects(fetchRawHeaders("https://cdn.test/raw"), /403/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

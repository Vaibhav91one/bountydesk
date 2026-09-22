import assert from "node:assert/strict";
import test from "node:test";

import { fetchInboundBody } from "./resend";

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

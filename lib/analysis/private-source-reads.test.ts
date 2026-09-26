import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import type { TrueForgeClient } from "@/lib/trueforge/client";

/**
 * The read-only source readers (the tier-3 static review and the sandboxability pre-check) against a
 * private repository, end to end on a disposable schema. The grant comes from real lifecycle rows,
 * and the token is minted and revoked by the real app-auth code with a real App key. Only GitHub
 * itself is faked, at fetch.
 */

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
process.env.GITHUB_APP_ID = "123456";
process.env.GITHUB_APP_PRIVATE_KEY_BASE64 = Buffer.from(privateKey).toString("base64");

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let staticReview: typeof import("./static-review");
let sandboxability: typeof import("./sandboxability");

const GRANTED = { id: 920001, account: { login: "acme", id: 6001, type: "Organization" } };
const UNGRANTED = { id: 920002, account: { login: "other", id: 6002, type: "Organization" } };
const READABLE = { id: 820001, full_name: "acme/secret", private: true };
const OPEN = { id: 820002, full_name: "acme/open", private: false };
const REFUSED = { id: 820003, full_name: "other/locked", private: true };

const TOKEN = "ghs_scopedReadToken0123456789";
const SOURCE = "app.post('/login', (req) => db.query(`SELECT * FROM users WHERE email = '${req.body.email}'`));";
const README = "# Secret shop\nRuns with `npm start` against its own sqlite file.";

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("private_source_reads");
  dbm = await import("@/lib/db");
  staticReview = await import("./static-review");
  sandboxability = await import("./sandboxability");
  const { applyLifecycle } = await import("@/lib/github/lifecycle");
  await applyLifecycle(dbm.db, "installation", {
    action: "created",
    installation: { ...GRANTED, permissions: { metadata: "read", issues: "write", contents: "read" } },
    repositories: [READABLE, OPEN],
  });
  await applyLifecycle(dbm.db, "installation", {
    action: "created",
    installation: { ...UNGRANTED, permissions: { metadata: "read", issues: "write" } },
    repositories: [REFUSED],
  });
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

type Call = { method: string; url: string; auth: string | null; body: string | null };
let calls: Call[] = [];
let warnings: string[] = [];
/** When set, the tree listing fails with an error that carries the request's Authorization header. */
let failTreeWithToken = false;

const realFetch = globalThis.fetch;
const realWarn = console.warn;

function authorized(call: Call, repo: { full_name: string; private: boolean }): boolean {
  return !repo.private || call.auth === `Bearer ${TOKEN}`;
}

beforeEach(() => {
  calls = [];
  warnings = [];
  failTreeWithToken = false;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      auth: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    if (url.startsWith("https://api.github.com/app/installations/") && call.method === "POST") {
      return Response.json({ token: TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (url === "https://api.github.com/installation/token" && call.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    for (const repo of [READABLE, OPEN]) {
      if (url.startsWith(`https://api.github.com/repos/${repo.full_name}/git/trees/`)) {
        if (failTreeWithToken) throw new Error(`socket hang up (${call.auth})`);
        if (!authorized(call, repo)) return new Response("Not Found", { status: 404 });
        return Response.json({
          tree: [
            { path: "README.md", type: "blob", size: README.length },
            { path: "routes/login.ts", type: "blob", size: SOURCE.length },
          ],
        });
      }
      const raw = `https://raw.githubusercontent.com/${repo.full_name}/HEAD/`;
      if (url.startsWith(raw)) {
        if (!authorized(call, repo)) return new Response("404: Not Found", { status: 404 });
        const path = url.slice(raw.length);
        if (path === "README.md") return new Response(README, { status: 206 });
        if (path === "routes/login.ts") return new Response(SOURCE, { status: 206 });
        return new Response("404: Not Found", { status: 404 });
      }
    }
    throw new Error(`unexpected fetch in test: ${call.method} ${url}`);
  }) as typeof fetch;
});

test.afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
});

/** The lifecycle webhook already queued an onboarding row for a readable repository; a refused one
 *  has none, so the test adds it. */
async function onboardingRow(repo: { id: number; full_name: string }): Promise<{ id: string }> {
  const [row] = await dbm.db
    .insert(dbm.targetOnboarding)
    .values({ repoId: repo.id, repoFullName: repo.full_name, sourceRef: `https://github.com/${repo.full_name}.git` })
    .onConflictDoNothing()
    .returning({ id: dbm.targetOnboarding.id });
  if (row) return row;
  const [existing] = await dbm.db
    .select({ id: dbm.targetOnboarding.id })
    .from(dbm.targetOnboarding)
    .where(dbm.eq(dbm.targetOnboarding.repoId, repo.id));
  return existing;
}

const mints = () => calls.filter((c) => c.url.endsWith("/access_tokens"));
const revokes = () => calls.filter((c) => c.method === "DELETE");
const reads = () => calls.filter((c) => c.url.includes("/git/trees/") || c.url.startsWith("https://raw."));

/** The token was minted once for this repository alone, narrowed to contents:read, used for every
 *  read, and revoked with nothing read after the revoke. */
function assertScopedAndRevoked(repoId: number) {
  assert.equal(mints().length, 1, "one token covers every read");
  assert.equal(mints()[0].url, `https://api.github.com/app/installations/${GRANTED.id}/access_tokens`);
  assert.deepEqual(JSON.parse(mints()[0].body ?? "{}"), { repository_ids: [repoId], permissions: { contents: "read" } });
  assert.ok(reads().length > 0);
  assert.ok(reads().every((c) => c.auth === `Bearer ${TOKEN}`), "every read carries the scoped token");
  assert.equal(revokes().length, 1);
  assert.equal(revokes()[0].auth, `Bearer ${TOKEN}`, "the minted token is the one revoked");
  assert.equal(calls.at(-1), revokes()[0], "nothing is read after the revoke");
}

test("the static review reads a private repository with Contents: read through a scoped, revoked token", async () => {
  const source = await staticReview.gatherStaticSource({
    repoFullName: READABLE.full_name,
    ref: null,
    reportText: "SQL injection in routes/login.ts",
  });
  assert.deepEqual(source.tree, ["routes/login.ts"]);
  assert.deepEqual(
    source.files.map((f) => f.path),
    ["README.md", "routes/login.ts"],
  );
  assert.equal(source.files[1].text, SOURCE);
  assertScopedAndRevoked(READABLE.id);
  assert.deepEqual(warnings, []);
});

test("a failed read still revokes the token and keeps it out of the logged error", async () => {
  failTreeWithToken = true;
  const source = await staticReview.gatherStaticSource({ repoFullName: READABLE.full_name, ref: null, reportText: "x" });
  assert.deepEqual(source.files, []);
  assert.equal(revokes().length, 1, "revoked even though the read failed");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[redacted\]/);
  assert.ok(!warnings[0].includes(TOKEN), "the token never reaches the log");
});

test("the sandboxability review embeds a private repository's files and revokes the token before the turn", async () => {
  const row = await onboardingRow(READABLE);
  let message = "";
  let callsAtSession = -1;
  const client = {
    async createSession() {
      callsAtSession = calls.length;
      return { sessionId: "s" };
    },
    async createTurn(_s: string, events: Array<{ content: string }>) {
      message = events[0].content;
      return { turnId: "t" };
    },
    async getTurn() { return { status: "done_no_action" }; },
    async deleteSession() {},
  } as unknown as TrueForgeClient;

  const result = await sandboxability.runSandboxabilityReview(client, {
    onboardingId: row.id,
    repoFullName: READABLE.full_name,
  });
  assert.equal(result.verdict, "unsure", "the fake turn reports nothing");
  assert.ok(message.includes(README), "the review sees the private README");
  assert.ok(!message.includes(TOKEN), "the token is never put in the prompt");
  assertScopedAndRevoked(READABLE.id);
  assert.equal(callsAtSession, calls.length, "the token is revoked before the agent turn starts");
});

test("a private repository without Contents: read is refused with zero fetches", async () => {
  const source = await staticReview.gatherStaticSource({ repoFullName: REFUSED.full_name, ref: null, reportText: "x" });
  assert.deepEqual(source, { ref: "HEAD", tree: [], files: [] });
  assert.match(warnings.join("\n"), /POLICY_REFUSED/);

  const row = await onboardingRow(REFUSED);
  let sessions = 0;
  const client = {
    async createSession() {
      sessions++;
      return { sessionId: "s" };
    },
  } as unknown as TrueForgeClient;
  const result = await sandboxability.runSandboxabilityReview(client, {
    onboardingId: row.id,
    repoFullName: REFUSED.full_name,
  });
  assert.equal(result.verdict, "unsure");
  assert.equal(sessions, 0, "no turn runs on a refused repository");
  assert.deepEqual(calls, [], "no mint and no read");
});

test("a public repository is still read anonymously and mints nothing", async () => {
  const source = await staticReview.gatherStaticSource({
    repoFullName: OPEN.full_name,
    ref: null,
    reportText: "routes/login.ts",
  });
  assert.equal(source.files.find((f) => f.path === "routes/login.ts")?.text, SOURCE);
  assert.equal(mints().length, 0);
  assert.equal(revokes().length, 0);
  assert.ok(reads().every((c) => c.auth === null), "no Authorization header on a public read");

  const row = await onboardingRow(OPEN);
  let message = "";
  const client = {
    async createSession() { return { sessionId: "s" }; },
    async createTurn(_s: string, events: Array<{ content: string }>) {
      message = events[0].content;
      return { turnId: "t" };
    },
    async getTurn() { return { status: "done_no_action" }; },
    async deleteSession() {},
  } as unknown as TrueForgeClient;
  await sandboxability.runSandboxabilityReview(client, { onboardingId: row.id, repoFullName: OPEN.full_name });
  assert.ok(message.includes(README));
  assert.equal(mints().length, 0);
  assert.ok(reads().every((c) => c.auth === null));
});

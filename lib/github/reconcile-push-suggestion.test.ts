import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

/**
 * Test reconcilePushSuggestions against a real Postgres. The guarantee under test is
 * the set of column writes the poller makes: it only writes to public, active,
 * non-deleted connected repositories that have a REPRODUCED verdict, and it leaves old
 * values on fetch failure. GitHub stays a fake fetch so the "GitHub says this is the
 * new HEAD" and "GitHub did not answer" cases are deterministic.
 *
 * The verdict table is append-only (no DELETE via triggers), but TRUNCATE is DDL and
 * bypasses that, giving each test a clean slate.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let reconcile: typeof import("./reconcile");

type FetchStub = (url: string, opts?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
const fakeFetch = (impl: FetchStub): typeof fetch =>
  ((url: string, opts?: { headers?: Record<string, string>; signal?: AbortSignal }) => impl(url, opts)) as typeof fetch;

let seq = 0;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("github_reconcile_push");
  dbm = await import("@/lib/db");
  reconcile = await import("./reconcile");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

// TRUNCATE all tables between tests. TRUNCATE is DDL so it bypasses the deny-mutation
// triggers on verdict (BEFORE DELETE on verdict fires per-row; TRUNCATE has no rows).
beforeEach(async () => {
  await dbm.db.execute(`truncate "connected_repository", "report", "verdict", "retest", "target_profile", "github_installation" cascade`);
  reconcile.__clearPollCache();
});

async function seedRepo(opts: {
  isPrivate?: boolean;
  active?: boolean;
  outcome?: "REPRODUCED" | "NOT_REPRODUCED" | "INCONCLUSIVE" | "ANALYSIS_ONLY";
  fullName?: string;
  defaultBranch?: string;
  preSetBranch?: boolean;
}): Promise<{ repoId: number; fullName: string; defaultBranch: string }> {
  seq += 1;
  const repoId = 800000 + seq;
  const fullName = opts.fullName ?? `acme/repo-${seq}`;
  const defaultBranch = opts.defaultBranch ?? "main";

  const [inst] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({ installationId: 900000 + seq, accountLogin: "acme", accountId: 700000 + seq })
    .returning({ id: dbm.githubInstallation.id });

  const [tp] = await dbm.db
    .insert(dbm.targetProfile)
    .values({ name: `target-${seq}`, imageDigest: `sha256:fixture-${seq}`, resolvedCommitSha: "0".repeat(40) })
    .returning({ id: dbm.targetProfile.id });

  const [conn] = await dbm.db
    .insert(dbm.connectedRepository)
    .values({
      installationId: inst.id,
      repoId,
      fullName,
      targetProfileId: tp.id,
      active: opts.active ?? true,
      isPrivate: opts.isPrivate ?? false,
      latestPushedBranch: opts.preSetBranch ? defaultBranch : null,
    })
    .returning({ id: dbm.connectedRepository.id });

  const [rep] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:${repoId}:issue:1`,
      title: "Test report",
      body: "test",
      state: "DELIVERED",
      connectedRepositoryId: conn.id,
      targetProfileId: tp.id,
    })
    .returning({ id: dbm.report.id });

  if (opts.outcome) {
    await dbm.db.insert(dbm.verdict).values({
      reportId: rep.id,
      outcome: opts.outcome,
      summary: "reproduced",
      payload: "{}",
      contentHash: "hash1",
    });
  }

  return { repoId, fullName, defaultBranch };
}

test("poller stores the SHA and branch for a public repo with a REPRODUCED report", async () => {
  const { repoId, fullName, defaultBranch } = await seedRepo({ outcome: "REPRODUCED", preSetBranch: true });
  const pushedSha = "a".repeat(40);

  const [owner, ...rest] = fullName.split("/");
  const repoName = rest.join("/");

  const fetchStub = fakeFetch(async (url: string) => {
    if (url === `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/commits/${encodeURIComponent(defaultBranch)}`) {
      return new Response(pushedSha, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });

  await reconcile.reconcilePushSuggestions({ fetchImpl: fetchStub });

  const [row] = await dbm.db
    .select({
      latestPushedCommitSha: dbm.connectedRepository.latestPushedCommitSha,
      latestPushedBranch: dbm.connectedRepository.latestPushedBranch,
    })
    .from(dbm.connectedRepository)
    .where(dbm.eq(dbm.connectedRepository.repoId, repoId));

  assert.equal(row.latestPushedCommitSha, pushedSha, "the polled SHA is stored");
  assert.equal(row.latestPushedBranch, defaultBranch, "the default branch name is stored");
});

test("poller fetches the correct URL with owner/repo encoded separately", async () => {
  const { repoId, defaultBranch } = await seedRepo({
    outcome: "REPRODUCED",
    fullName: "acme/with-dash.repo",
    preSetBranch: true,
  });
  const pushedSha = "c".repeat(40);
  let fetchedUrl = "";

  const fetchStub = fakeFetch(async (url: string) => {
    fetchedUrl = url;
    return new Response(pushedSha, { status: 200 });
  });

  await reconcile.reconcilePushSuggestions({ fetchImpl: fetchStub });

  assert.equal(
    fetchedUrl,
    `https://api.github.com/repos/acme/with-dash.repo/commits/${defaultBranch}`,
    "owner and repo are encoded separately, no %2F in the path",
  );

  const [row] = await dbm.db
    .select({ latestPushedCommitSha: dbm.connectedRepository.latestPushedCommitSha })
    .from(dbm.connectedRepository)
    .where(dbm.eq(dbm.connectedRepository.repoId, repoId));

  assert.equal(row.latestPushedCommitSha, pushedSha, "the polled SHA is stored");
});

test("poller skips private repositories", async () => {
  const { repoId } = await seedRepo({ outcome: "REPRODUCED", isPrivate: true });
  let called = false;
  const fetchStub = fakeFetch(async () => {
    called = true;
    return new Response("not found", { status: 404 });
  });

  await reconcile.reconcilePushSuggestions({ fetchImpl: fetchStub });

  const [row] = await dbm.db
    .select({ latestPushedCommitSha: dbm.connectedRepository.latestPushedCommitSha })
    .from(dbm.connectedRepository)
    .where(dbm.eq(dbm.connectedRepository.repoId, repoId));

  assert.equal(row.latestPushedCommitSha, null, "private repos are skipped");
  assert.equal(called, false, "fetch is not called for private repos");
});

test("poller skips repositories without a REPRODUCED report", async () => {
  const { repoId } = await seedRepo({ outcome: "NOT_REPRODUCED" });
  let called = false;
  const fetchStub = fakeFetch(async () => {
    called = true;
    return new Response("should not be called", { status: 500 });
  });

  await reconcile.reconcilePushSuggestions({ fetchImpl: fetchStub });

  const [row] = await dbm.db
    .select({ latestPushedCommitSha: dbm.connectedRepository.latestPushedCommitSha })
    .from(dbm.connectedRepository)
    .where(dbm.eq(dbm.connectedRepository.repoId, repoId));

  assert.equal(row.latestPushedCommitSha, null, "non-REPRODUCED repos are skipped");
  assert.equal(called, false, "fetch is not called for non-REPRODUCED repos");
});

test("poller keeps the old value on fetch error", async () => {
  const { repoId, defaultBranch } = await seedRepo({ outcome: "REPRODUCED", preSetBranch: true });
  const oldSha = "b".repeat(40);

  await dbm.db
    .update(dbm.connectedRepository)
    .set({ latestPushedCommitSha: oldSha, latestPushedBranch: defaultBranch })
    .where(dbm.eq(dbm.connectedRepository.repoId, repoId));

  const fetchStub = fakeFetch(async () => new Response("server error", { status: 500 }));

  await reconcile.reconcilePushSuggestions({ fetchImpl: fetchStub });

  const [row] = await dbm.db
    .select({ latestPushedCommitSha: dbm.connectedRepository.latestPushedCommitSha })
    .from(dbm.connectedRepository)
    .where(dbm.eq(dbm.connectedRepository.repoId, repoId));

  assert.equal(row.latestPushedCommitSha, oldSha, "the old value survives a failed poll");
});

test("poller skips repositories on an inactive installation", async () => {
  const { repoId } = await seedRepo({ outcome: "REPRODUCED", active: false });
  let called = false;
  const fetchStub = fakeFetch(async () => {
    called = true;
    return new Response("should not be called", { status: 500 });
  });

  await reconcile.reconcilePushSuggestions({ fetchImpl: fetchStub });

  const [row] = await dbm.db
    .select({ latestPushedCommitSha: dbm.connectedRepository.latestPushedCommitSha })
    .from(dbm.connectedRepository)
    .where(dbm.eq(dbm.connectedRepository.repoId, repoId));

  assert.equal(row.latestPushedCommitSha, null, "inactive repos are skipped");
  assert.equal(called, false, "fetch is not called for inactive repos");
});

test("poller stops on 403 rate-limit and does not check further repos", async () => {
  // Seed two repos so we can verify the poller stops after the first one hits the rate limit.
  await seedRepo({ outcome: "REPRODUCED", fullName: "acme/repo-a", preSetBranch: true });
  await seedRepo({ outcome: "REPRODUCED", fullName: "acme/repo-b", preSetBranch: true });

  let callCount = 0;
  const fetchStub = fakeFetch(async () => {
    callCount += 1;
    return new Response("rate limited", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
    });
  });

  await reconcile.reconcilePushSuggestions({ fetchImpl: fetchStub });

  assert.equal(callCount, 1, "only the first repo is fetched before rate limit stops the tick");
});

test("poller skips a repo polled within the last 15 minutes on the second call", async () => {
  const { repoId } = await seedRepo({ outcome: "REPRODUCED", fullName: "acme/skip-test", preSetBranch: true });
  const pushedSha = "d".repeat(40);

  let callCount = 0;
  const fetchStub = fakeFetch(async () => {
    callCount += 1;
    return new Response(pushedSha, { status: 200 });
  });

  // First poll: fetches the SHA.
  await reconcile.reconcilePushSuggestions({ fetchImpl: fetchStub });
  assert.equal(callCount > 0, true, "first call fetches");

  const firstCount = callCount;

  // Second poll within 15 minutes: should skip, no new fetches.
  await reconcile.reconcilePushSuggestions({ fetchImpl: fetchStub });
  assert.equal(callCount, firstCount, "second call within 15 minutes is skipped");

  const [row] = await dbm.db
    .select({ latestPushedCommitSha: dbm.connectedRepository.latestPushedCommitSha })
    .from(dbm.connectedRepository)
    .where(dbm.eq(dbm.connectedRepository.repoId, repoId));

  assert.equal(row.latestPushedCommitSha, pushedSha, "the SHA was stored on the first poll");
});

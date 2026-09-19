// Offline tests for the PR-Agent review verifier.
//
// Why fixtures: the verifier only talks to GitHub through an injected fetch,
// so each test replays a sanitized fixture instead of the network. That keeps
// the gate deterministic in CI and keeps credentials out of the test tree: the
// only secret-shaped value here is a dummy bearer asserted to never surface.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  GitHubApiError,
  buildSummary,
  extractMarkerHead,
  verifyPrAgentReview,
  withRetry,
} from "./verify-pr-agent-review.mjs";

const REPOSITORY = "octo/example";
const PR_NUMBER = 7;
const HEAD = "1111111111111111111111111111111111111111";
const OLD_HEAD = "2222222222222222222222222222222222222222";
const FIXTURES = new URL("./pr-agent-review-fixtures/", import.meta.url);

async function loadFixture(name) {
  const raw = await readFile(new URL(`${name}.json`, FIXTURES), "utf8");
  return JSON.parse(raw);
}

function ok(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function fail(status) {
  return { ok: false, status, json: async () => ({ message: "error" }) };
}

// Routes stubbed requests to the matching fixture slice. Order matters: the
// reviews path also contains the pulls path, so it is matched first.
function stubFetchFor(fixture, seen = null) {
  return async (url, options) => {
    if (seen) seen.push({ url: String(url), authorization: options?.headers?.authorization });
    const target = String(url);
    if (target.includes(`/pulls/${PR_NUMBER}/reviews`)) return ok(fixture.reviews ?? []);
    if (target.includes(`/issues/${PR_NUMBER}/comments`)) return ok(fixture.comments ?? []);
    if (target.includes("/actions/runs?")) return ok({ workflow_runs: fixture.run ? [fixture.run] : [] });
    if (/\/actions\/runs\/\d+/.test(target)) return fixture.run ? ok(fixture.run) : fail(404);
    if (target.includes(`/pulls/${PR_NUMBER}`)) return ok(fixture.pull);
    throw new Error(`unexpected request: ${target}`);
  };
}

async function verifyFixture(name, overrides = {}) {
  const fixture = await loadFixture(name);
  const seen = [];
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: fixture.run?.id ?? null,
    token: "dummy-bearer-for-tests",
    fetchImpl: stubFetchFor(fixture, seen),
    ...overrides,
  });
  return { fixture, verdict, seen };
}

test("success fixture verifies a formal review bound to the current head", async () => {
  const { verdict } = await verifyFixture("success");
  assert.equal(verdict.status, "VERIFIED");
  assert.equal(verdict.reason, "REVIEW_BOUND_TO_HEAD");
  assert.equal(verdict.headSha, HEAD);
  assert.deepEqual(verdict.evidence.formalReviewIds, [9001]);
});

test("the canonical PR-Agent persistent marker verifies a current-head comment", async () => {
  const fixture = await loadFixture("success");
  fixture.reviews = [];
  fixture.run.created_at = "2026-09-19T00:00:00Z";
  fixture.comments = [{
    id: 9011,
    user: { login: "github-actions[bot]" },
    created_at: "2026-09-19T00:01:00Z",
    body: "<!-- pr-agent:review:full -->\n## PR Reviewer Guide\nNo major issues found.",
  }];
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: fixture.run.id,
    fetchImpl: stubFetchFor(fixture),
  });
  assert.equal(verdict.status, "NO_FINDINGS");
  assert.deepEqual(verdict.evidence.persistentCommentIds, [9011]);
});

test("a canonical comment from before the run is not current publication", async () => {
  const fixture = await loadFixture("success");
  fixture.run.created_at = "2026-09-19T00:01:00Z";
  fixture.reviews = [];
  fixture.comments = [{
    id: 9013,
    user: { login: "github-actions[bot]" },
    created_at: "2026-09-19T00:00:00Z",
    body: "<!-- pr-agent:review:full -->\n## PR Reviewer Guide\nNo major issues found.",
  }];
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: fixture.run.id,
    fetchImpl: stubFetchFor(fixture),
  });
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "STANDALONE_ONLY");
});

test("a canonical standalone publication still fails verification", async () => {
  const fixture = await loadFixture("success");
  fixture.reviews = [];
  fixture.comments = [{
    id: 9012,
    user: { login: "github-actions[bot]" },
    body: "<!-- pr-agent:review:full -->\n## Standalone PR Review\nPR-Agent could not safely update the persistent review.",
  }];
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: fixture.run.id,
    fetchImpl: stubFetchFor(fixture),
  });
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "PUBLICATION_FAILURE");
});

test("a review declaring no findings is NO_FINDINGS, not UNVERIFIED", async () => {
  const fixture = await loadFixture("success");
  fixture.reviews = [
    {
      id: 9010,
      state: "COMMENTED",
      commit_id: HEAD,
      user: { login: "github-actions[bot]" },
      body: "## PR Reviewer Guide\n\nPR-Agent review: no major issues found. All clear.",
    },
  ];
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: fixture.run.id,
    fetchImpl: stubFetchFor(fixture),
  });
  assert.equal(verdict.status, "NO_FINDINGS");
  assert.equal(verdict.reason, "NO_FINDINGS_DECLARED");
});

test("fork pull requests are explicitly skipped before review evidence is accepted", async () => {
  const fixture = await loadFixture("success");
  fixture.pull.head.repo = { full_name: "contributor/example" };
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: fixture.run.id,
    fetchImpl: stubFetchFor(fixture),
  });
  assert.equal(verdict.status, "SKIPPED");
  assert.equal(verdict.reason, "FORK_UNSUPPORTED");
});

test("stale head fixture rejects a formal review bound to an older commit", async () => {
  const { verdict } = await verifyFixture("stale-head");
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "STALE_HEAD");
});

test("missing publication fixture reports no review at all", async () => {
  const { verdict } = await verifyFixture("missing-publication");
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "MISSING_PUBLICATION");
});

test("standalone failure fixture rejects unbound review text", async () => {
  const { verdict } = await verifyFixture("standalone-failure");
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "STANDALONE_ONLY");
});

test("malformed marker fixture rejects a truncated head SHA", async () => {
  const { verdict } = await verifyFixture("malformed-marker");
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "MALFORMED_MARKER");
  assert.equal(extractMarkerHead("<!-- pr-agent-review head=12345 -->").malformed, true);
});

test("old head fixture rejects a persistent comment bound to a prior head", async () => {
  const { verdict, fixture } = await verifyFixture("old-head");
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "STALE_HEAD");
  const marker = extractMarkerHead(fixture.comments[0].body);
  assert.equal(marker.present, true);
  assert.equal(marker.malformed, false);
  assert.equal(marker.head, OLD_HEAD);
});

test("failed run fixture rejects a non-success conclusion despite a valid review", async () => {
  const { verdict } = await verifyFixture("failed-run");
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "RUN_NOT_SUCCESS");
});

test("head mutation fixture rejects a run left behind by a newer push", async () => {
  const { verdict, fixture } = await verifyFixture("head-mutation");
  assert.equal(fixture.run.head_sha, OLD_HEAD);
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "STALE_RUN");
});

test("a current-head publication carrying a publishing failure is rejected", async () => {
  const fixture = await loadFixture("success");
  fixture.reviews[0].body = "## PR Reviewer Guide\n\nPR-Agent failed to publish the full review: publication failed.";
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: fixture.run.id,
    fetchImpl: stubFetchFor(fixture),
  });
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "PUBLICATION_FAILURE");
});

test("a current-head publication carrying a parse failure is rejected", async () => {
  const fixture = await loadFixture("success");
  fixture.reviews[0].body = "## PR Reviewer Guide\n\nPR-Agent review failed to parse the model output (parse error).";
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: fixture.run.id,
    fetchImpl: stubFetchFor(fixture),
  });
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "PARSE_FAILURE");
});

test("a dismissed formal review does not count as publication", async () => {
  const fixture = await loadFixture("success");
  fixture.reviews[0].state = "DISMISSED";
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: fixture.run.id,
    fetchImpl: stubFetchFor(fixture),
  });
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "MISSING_PUBLICATION");
});

test("untrusted authors cannot turn matching review text into publication", async () => {
  const fixture = await loadFixture("success");
  fixture.reviews[0].user = { login: "untrusted-user" };
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: fixture.run.id,
    fetchImpl: stubFetchFor(fixture),
  });
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "MISSING_PUBLICATION");
});

test("run discovery finds the newest linked run when no id is pinned", async () => {
  const fixture = await loadFixture("success");
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: null,
    fetchImpl: stubFetchFor(fixture),
  });
  assert.equal(verdict.status, "VERIFIED");
  assert.equal(verdict.runId, fixture.run.id);
});

test("retry helper recovers from transient failures within its bound", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new GitHubApiError(500, "/x");
      return "steady";
    },
    { attempts: 3, delayMs: 1 },
  );
  assert.equal(result, "steady");
  assert.equal(calls, 3);
});

test("retry helper gives up after its bound and never retries a 404", async () => {
  let serverErrors = 0;
  await assert.rejects(
    withRetry(
      async () => {
        serverErrors += 1;
        throw new GitHubApiError(503, "/x");
      },
      { attempts: 3, delayMs: 1 },
    ),
    GitHubApiError,
  );
  assert.equal(serverErrors, 3);

  let clientErrors = 0;
  await assert.rejects(
    withRetry(
      async () => {
        clientErrors += 1;
        throw new GitHubApiError(404, "/x");
      },
      { attempts: 3, delayMs: 1 },
    ),
    GitHubApiError,
  );
  assert.equal(clientErrors, 1);
});

test("verdict and step summary never carry the bearer token", async () => {
  const { verdict, seen } = await verifyFixture("success");
  assert.ok(seen.length > 0);
  assert.ok(seen.every((request) => request.authorization === "Bearer dummy-bearer-for-tests"));
  assert.ok(!JSON.stringify(verdict).includes("dummy-bearer-for-tests"));
  const summary = buildSummary(verdict);
  assert.ok(!summary.includes("dummy-bearer-for-tests"));
  assert.match(summary, /status: VERIFIED/);
  assert.match(summary, new RegExp(`head: ${HEAD.slice(0, 12)}`));
});

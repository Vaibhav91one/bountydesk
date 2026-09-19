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

test("an empty pull_requests linkage is tolerated when the run is pinned", async () => {
  const { verdict, fixture } = await verifyFixture("run-link-empty");
  assert.deepEqual(fixture.run.pull_requests, []);
  assert.equal(verdict.status, "VERIFIED");
  assert.equal(verdict.reason, "REVIEW_BOUND_TO_HEAD");
});

test("empty linkage is not discoverable without a pinned run id", async () => {
  const fixture = await loadFixture("run-link-empty");
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: null,
    fetchImpl: stubFetchFor(fixture),
  });
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "RUN_NOT_FOUND");
});

test("a missing pull_requests linkage is tolerated when the run is pinned", async () => {
  const { verdict, fixture } = await verifyFixture("run-link-missing");
  assert.ok(!("pull_requests" in fixture.run));
  assert.equal(verdict.status, "VERIFIED");
  assert.equal(verdict.reason, "REVIEW_BOUND_TO_HEAD");
});

test("a run linked to several pull requests is ambiguous", async () => {
  const { verdict } = await verifyFixture("run-link-multi");
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "RUN_MISMATCH");
});

test("a run linked to a different pull request is rejected", async () => {
  const { verdict } = await verifyFixture("run-link-wrong-pr");
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "RUN_MISMATCH");
});

test("discovery ignores runs linked to a different pull request", async () => {
  const fixture = await loadFixture("run-link-wrong-pr");
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: null,
    fetchImpl: stubFetchFor(fixture),
  });
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "RUN_NOT_FOUND");
});

test("a run from the wrong workflow is rejected", async () => {
  const { verdict } = await verifyFixture("wrong-workflow");
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "RUN_MISMATCH");
});

test("discovery ignores runs from the wrong workflow", async () => {
  const fixture = await loadFixture("wrong-workflow");
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: null,
    fetchImpl: stubFetchFor(fixture),
  });
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "RUN_NOT_FOUND");
});

test("a run from a different repository is rejected", async () => {
  const { verdict } = await verifyFixture("wrong-repository");
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "RUN_MISMATCH");
});

test("a run from a different repository is rejected through the fallback field", async () => {
  const { verdict } = await verifyFixture("wrong-repository-fallback");
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "RUN_MISMATCH");
});

test("a run without repository fields still verifies on exact head and link", async () => {
  const { verdict, fixture } = await verifyFixture("success");
  assert.ok(!("head_repository" in fixture.run));
  assert.ok(!("repository" in fixture.run));
  assert.equal(verdict.status, "VERIFIED");
});

test("a review with a missing publisher is not trusted", async () => {
  const fixture = await loadFixture("success");
  delete fixture.reviews[0].user;
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: fixture.run.id,
    fetchImpl: stubFetchFor(fixture),
  });
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "MISSING_PUBLICATION");
});

test("a stale canonical comment is standalone, not a stale head binding", async () => {
  const { verdict } = await verifyFixture("stale-canonical");
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "STANDALONE_ONLY");
});

test("a canonical comment without timestamps is not current publication", async () => {
  const { verdict } = await verifyFixture("canonical-missing-timestamps");
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "STANDALONE_ONLY");
});

test("a canonical comment with unparsable timestamps is not current publication", async () => {
  const fixture = await loadFixture("success");
  fixture.reviews = [];
  fixture.run.created_at = "2026-09-19T00:00:00Z";
  fixture.comments = [{
    id: 9027,
    user: { login: "github-actions[bot]" },
    created_at: "not-a-timestamp",
    updated_at: "also-not-a-timestamp",
    body: "<!-- pr-agent:review:full -->\n## PR Reviewer Guide\nPR-Agent review found 2 issues worth a look.",
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

test("a canonical comment verifies on updated_at even when created_at predates the run", async () => {
  const { verdict } = await verifyFixture("canonical-updated-after");
  assert.equal(verdict.status, "VERIFIED");
  assert.equal(verdict.reason, "REVIEW_BOUND_TO_HEAD");
  assert.deepEqual(verdict.evidence.persistentCommentIds, [9023]);
});

test("a canonical comment verifies through the run_started_at fallback", async () => {
  const { verdict, fixture } = await verifyFixture("canonical-run-started-fallback");
  assert.ok(!("created_at" in fixture.run));
  assert.equal(verdict.status, "NO_FINDINGS");
  assert.deepEqual(verdict.evidence.persistentCommentIds, [9024]);
});

test("a run without any timestamps cannot anchor a canonical comment", async () => {
  const fixture = await loadFixture("success");
  fixture.reviews = [];
  fixture.run.created_at = undefined;
  delete fixture.run.created_at;
  delete fixture.run.run_started_at;
  fixture.comments = [{
    id: 9028,
    user: { login: "github-actions[bot]" },
    created_at: "2026-09-19T00:01:00Z",
    body: "<!-- pr-agent:review:full -->\n## PR Reviewer Guide\nPR-Agent review found 2 issues worth a look.",
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

test("a formal review carries no timestamp binding beyond its head SHA", async () => {
  const fixture = await loadFixture("success");
  fixture.reviews[0].submitted_at = "2020-01-01T00:00:00Z";
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: fixture.run.id,
    fetchImpl: stubFetchFor(fixture),
  });
  assert.equal(verdict.status, "VERIFIED");
  assert.equal(verdict.reason, "REVIEW_BOUND_TO_HEAD");
});

test("an unbound parse failure poisons an otherwise bound publication", async () => {
  const { verdict } = await verifyFixture("failure-precedence");
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "PARSE_FAILURE");
});

test("a parse failure wins over a publication failure in the same body", async () => {
  const fixture = await loadFixture("success");
  fixture.reviews[0].body = "## PR Reviewer Guide\n\nPR-Agent failed to parse the output and failed to publish the review.";
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: fixture.run.id,
    fetchImpl: stubFetchFor(fixture),
  });
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "PARSE_FAILURE");
});

test("a failure marker beats a clean-bill-of-health sentence in bound output", async () => {
  const fixture = await loadFixture("success");
  fixture.reviews[0].body = "## PR Reviewer Guide\n\nPR-Agent review: no major issues found, but publication failed for this run.";
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: fixture.run.id,
    fetchImpl: stubFetchFor(fixture),
  });
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "PUBLICATION_FAILURE");
});

test("a formal commit_id matches the head case-insensitively but must be exact", async () => {
  const upper = await loadFixture("success");
  upper.reviews[0].commit_id = HEAD.toUpperCase();
  const upperVerdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: upper.run.id,
    fetchImpl: stubFetchFor(upper),
  });
  assert.equal(upperVerdict.status, "VERIFIED");

  const prefix = await loadFixture("success");
  prefix.reviews[0].commit_id = HEAD.slice(0, 12);
  const prefixVerdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: prefix.run.id,
    fetchImpl: stubFetchFor(prefix),
  });
  assert.equal(prefixVerdict.status, "UNVERIFIED");
  assert.equal(prefixVerdict.reason, "STANDALONE_ONLY");
});

test("a legacy head marker alone never verifies, even on the current head", async () => {
  const { verdict } = await verifyFixture("legacy-current-head");
  assert.equal(verdict.status, "UNVERIFIED");
  assert.equal(verdict.reason, "STANDALONE_ONLY");
});

test("discovery picks the newest run with an exact current-head link", async () => {
  const fixture = await loadFixture("success");
  const older = { ...fixture.run, id: 201 };
  const newer = { ...fixture.run, id: 202 };
  const otherPr = { ...fixture.run, id: 203, pull_requests: [{ number: 8 }] };
  const multiPr = { ...fixture.run, id: 204, pull_requests: [{ number: 7 }, { number: 8 }] };
  const wrongName = { ...fixture.run, id: 205, name: "Build" };
  const fetchImpl = async (url, options) => {
    void options;
    const target = String(url);
    if (target.includes(`/pulls/${PR_NUMBER}/reviews`)) return ok(fixture.reviews ?? []);
    if (target.includes(`/issues/${PR_NUMBER}/comments`)) return ok(fixture.comments ?? []);
    if (target.includes("/actions/runs?")) {
      return ok({ workflow_runs: [older, newer, otherPr, multiPr, wrongName] });
    }
    if (target.includes(`/pulls/${PR_NUMBER}`)) return ok(fixture.pull);
    throw new Error(`unexpected request: ${target}`);
  };
  const verdict = await verifyPrAgentReview({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    runId: null,
    fetchImpl,
  });
  assert.equal(verdict.status, "VERIFIED");
  assert.equal(verdict.runId, 202);
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

// Verifier for advisory PR-Agent reviews.
//
// Why this file exists: PR-Agent posts model-generated suggestions that a human
// must still judge, so CI needs a deterministic check that a review was actually
// published for the current PR head before anyone relies on it. This script binds
// three facts together over GitHub REST: the pull request head SHA, the workflow
// run identity and conclusion, and a review publication bound to that head.
//
// What counts as publication: a formal pull request review whose commit_id equals
// the current head SHA, or a persistent issue comment carrying a head marker
// (`pr-agent-review head=<40-hex-sha>`). Inline diff comments alone are not
// enough because they carry no head binding, which is why they are rejected as
// standalone. Anything stale, malformed, or carrying a failure marker is
// UNVERIFIED, and an explicit clean bill of health is reported as NO_FINDINGS
// rather than lumped in with UNVERIFIED.
//
// Only Node built-ins are used. `fetch` is injectable so the offline tests can
// run on fixtures without network or credentials. Secrets never reach logs:
// request failures report the path and status only, and the step summary carries
// verdict codes and short SHAs, never tokens or review bodies.

import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const API_VERSION = "2022-11-28";
const DEFAULT_API_BASE_URL = "https://api.github.com";
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;

// A body is treated as PR-Agent output when it carries the product name or the
// familiar review guide heading. The publisher allowlist prevents arbitrary PR
// commenters from manufacturing review evidence.
const PR_AGENT_BODY_RE = /pr-agent|PR Reviewer Guide/i;
const TRUSTED_PUBLISHERS = new Set(["github-actions[bot]", "pr-agent[bot]", "pr-agent"]);

// Persistent comments are not commit-bound by the API, so they carry their own
// binding. The capture is intentionally loose (up to 64 alphanumerics) so a
// truncated or mistyped SHA is reported as MALFORMED_MARKER, not silently
// treated as missing.
const HEAD_MARKER_RE = /pr-agent-review[\s\S]{0,200}?head\s*=\s*([A-Za-z0-9]{1,64})/i;
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

const PUBLICATION_FAILURE_RES = [
  /failed to publish/i,
  /publication failed/i,
  /failed to post/i,
  /could not publish/i,
  /could not safely update/i,
  /standalone pr review/i,
  /failed to generate/i,
  /pr-agent[\s\S]{0,30}fail/i,
  /review[\s\S]{0,30}fail(?:ed|ure)/i,
];

const PARSE_FAILURE_RES = [/failed to parse/i, /parse (?:error|failure|failed)/i];

// Kept narrow on purpose: only an explicit clean bill of health becomes
// NO_FINDINGS. Anything else bound to the head is VERIFIED (reviewed, outcome
// unstated), which a human still has to read.
const NO_FINDINGS_RES = [
  /no (?:major|significant|critical|relevant|new|serious) (?:issues|findings|concerns|problems)/i,
  /no issues found/i,
  /looks good to me/i,
  /\blgtm\b/i,
  /all clear/i,
];

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

// Carries status and path only, so a thrown request error can never leak the
// Authorization header or a token into logs.
export class GitHubApiError extends Error {
  constructor(status, path) {
    super(`GitHub API request failed: ${path} (status ${status})`);
    this.name = "GitHubApiError";
    this.status = status;
    this.path = path;
  }
}

export function isRetryable(error) {
  const status = error?.status;
  if (typeof status !== "number") return true;
  return status === 429 || status >= 500;
}

// Bounded retry for flaky CI network and GitHub 5xx/429 responses. The attempt
// cap is what makes this safe to call from a verification gate: a persistent
// failure surfaces as UNVERIFIED instead of hanging the job.
export async function withRetry(operation, { attempts = MAX_ATTEMPTS, delayMs = RETRY_BASE_DELAY_MS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}

export function isPrAgentBody(body) {
  return typeof body === "string" && PR_AGENT_BODY_RE.test(body);
}

export function isFullSha(value) {
  return typeof value === "string" && FULL_SHA_RE.test(value);
}

// Reads the head marker out of a persistent comment. `present` false means no
// marker at all (standalone text), while `malformed` true means a marker that
// names a SHA failing the 40-hex check.
export function extractMarkerHead(body) {
  if (typeof body !== "string") return { present: false, head: null, malformed: false };
  const match = HEAD_MARKER_RE.exec(body);
  if (!match) return { present: false, head: null, malformed: false };
  const head = match[1];
  if (!isFullSha(head)) return { present: true, head, malformed: true };
  return { present: true, head: head.toLowerCase(), malformed: false };
}

function matchesAny(patterns, body) {
  return patterns.some((pattern) => pattern.test(body));
}

function shortSha(sha) {
  return typeof sha === "string" && sha.length >= 12 ? sha.slice(0, 12) : String(sha ?? "unknown");
}

async function apiGet(fetchImpl, baseUrl, path, token) {
  return withRetry(async () => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) throw new GitHubApiError(response.status, path);
    return response.json();
  });
}

// Fallback when the caller does not pin a run id: take the newest PR-Agent run
// linked to this PR number, or else the newest one on the same head SHA. Runs
// are ordered by id, which is monotonic, so "newest" is deterministic.
async function discoverPrAgentRun(fetchImpl, baseUrl, repository, prNumber, token, headSha) {
  const data = await apiGet(
    fetchImpl,
    baseUrl,
    `/repos/${repository}/actions/runs?per_page=20`,
    token,
  );
  const runs = (data?.workflow_runs ?? []).filter((run) => /pr.agent/i.test(run?.name ?? ""));
  const linked = runs.filter((run) => (run?.pull_requests ?? []).some((pr) => pr?.number === prNumber));
  const pool = linked.length > 0
    ? linked
    : runs.filter((run) => (run?.head_sha ?? "").toLowerCase() === headSha.toLowerCase());
  if (pool.length === 0) return null;
  return pool.reduce((newest, run) => (run.id > newest.id ? run : newest));
}

function unverified(repository, prNumber, headSha, run, reason, detail) {
  return {
    status: "UNVERIFIED",
    reason,
    detail,
    repository,
    prNumber,
    headSha,
    runId: run?.id ?? null,
    runName: run?.name ?? null,
    evidence: { formalReviewIds: [], persistentCommentIds: [] },
  };
}

function collectCandidates(headSha, run, reviews, comments) {
  const candidates = [];
  const runStartedAt = Date.parse(run?.created_at ?? run?.run_started_at ?? "");
  for (const review of reviews ?? []) {
    if (!review || typeof review !== "object") continue;
    const body = typeof review.body === "string" ? review.body : "";
    if (!isPrAgentBody(body)) continue;
    const publisher = review.user?.login;
    if (publisher && !TRUSTED_PUBLISHERS.has(publisher)) continue;
    // A dismissed formal review is retracted content, so it must not verify.
    if (String(review.state ?? "").toUpperCase() === "DISMISSED") continue;
    const commitId = typeof review.commit_id === "string" ? review.commit_id : null;
    const binding = !isFullSha(commitId)
      ? "unbound"
      : commitId.toLowerCase() === headSha.toLowerCase()
        ? "head"
        : "stale";
    candidates.push({ kind: "formal-review", binding, id: review.id ?? null, body });
  }
  for (const comment of comments ?? []) {
    if (!comment || typeof comment !== "object") continue;
    const body = typeof comment.body === "string" ? comment.body : "";
    if (!isPrAgentBody(body)) continue;
    const publisher = comment.user?.login;
    if (publisher && !TRUSTED_PUBLISHERS.has(publisher)) continue;
    const marker = extractMarkerHead(body);
    const commentTime = Date.parse(comment.updated_at ?? comment.updatedAt ?? comment.created_at ?? "");
    const timeBound = Number.isFinite(runStartedAt) && Number.isFinite(commentTime) && commentTime >= runStartedAt;
    const binding = marker.malformed
      ? "malformed"
      : !marker.present
        ? timeBound ? "time-bound" : "unbound"
        : marker.head === headSha.toLowerCase()
          ? "head"
          : "stale";
    candidates.push({ kind: "persistent-comment", binding, id: comment.id ?? null, body });
  }
  return candidates;
}

function classifyPublication({ repository, prNumber, headSha, run, reviews, comments }) {
  const candidates = collectCandidates(headSha, run, reviews, comments);
  const headBound = candidates.filter((candidate) => candidate.binding === "head");
  const timeBound = candidates.filter((candidate) => candidate.binding === "time-bound");
  const bound = [...headBound, ...timeBound];
  const evidence = {
    formalReviewIds: bound
      .filter((candidate) => candidate.kind === "formal-review")
      .map((candidate) => candidate.id),
    persistentCommentIds: bound
      .filter((candidate) => candidate.kind === "persistent-comment")
      .map((candidate) => candidate.id),
  };
  const base = { repository, prNumber, headSha, runId: run?.id ?? null, runName: run?.name ?? null, evidence };

  if (headBound.length === 0 && timeBound.length === 0) {
    if (candidates.some((candidate) => candidate.binding === "malformed")) {
      return { ...base, status: "UNVERIFIED", reason: "MALFORMED_MARKER", detail: "pr-agent head marker is not a 40-hex SHA" };
    }
    if (candidates.some((candidate) => candidate.binding === "stale")) {
      return { ...base, status: "UNVERIFIED", reason: "STALE_HEAD", detail: `publication is bound to an older head, not ${shortSha(headSha)}` };
    }
    if (candidates.length > 0) {
      return { ...base, status: "UNVERIFIED", reason: "STANDALONE_ONLY", detail: "pr-agent text found without a current-head binding" };
    }
    return { ...base, status: "UNVERIFIED", reason: "MISSING_PUBLICATION", detail: "no pr-agent formal review or persistent comment found" };
  }
  // Parse is checked first because it is upstream of publishing: a review that
  // was never parsed has no publishable content, so its parse failure is the
  // root cause even when the body also mentions a failed review.
  if (bound.some((candidate) => matchesAny(PARSE_FAILURE_RES, candidate.body))) {
    return { ...base, status: "UNVERIFIED", reason: "PARSE_FAILURE", detail: "current-head publication reports a parse failure" };
  }
  if (bound.some((candidate) => matchesAny(PUBLICATION_FAILURE_RES, candidate.body))) {
    return { ...base, status: "UNVERIFIED", reason: "PUBLICATION_FAILURE", detail: "current-head publication reports a publishing failure" };
  }
  if (bound.some((candidate) => extractMarkerHead(candidate.body).malformed)) {
    return { ...base, status: "UNVERIFIED", reason: "MALFORMED_MARKER", detail: "current-head publication carries a malformed head marker" };
  }
  if (bound.every((candidate) => matchesAny(NO_FINDINGS_RES, candidate.body))) {
    return { ...base, status: "NO_FINDINGS", reason: "NO_FINDINGS_DECLARED", detail: "review bound to current head declares no findings" };
  }
  return { ...base, status: "VERIFIED", reason: "REVIEW_BOUND_TO_HEAD", detail: "pr-agent review bound to current head" };
}

export async function verifyPrAgentReview({
  repository,
  prNumber,
  runId = null,
  token = null,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = DEFAULT_API_BASE_URL,
} = {}) {
  if (typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new UsageError('repository must be "owner/repo"');
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new UsageError("prNumber must be a positive integer");
  }

  let pull;
  try {
    pull = await apiGet(fetchImpl, apiBaseUrl, `/repos/${repository}/pulls/${prNumber}`, token);
  } catch (error) {
    void error;
    return unverified(repository, prNumber, null, null, "PULL_FETCH_FAILED", "could not read the pull request head");
  }
  const headSha = pull?.head?.sha;
  if (!isFullSha(headSha)) {
    return unverified(repository, prNumber, null, null, "PULL_FETCH_FAILED", "pull request head SHA is missing or malformed");
  }

  let run;
  try {
    run = runId == null
      ? await discoverPrAgentRun(fetchImpl, apiBaseUrl, repository, prNumber, token, headSha)
      : await apiGet(fetchImpl, apiBaseUrl, `/repos/${repository}/actions/runs/${runId}`, token);
  } catch (error) {
    void error;
    return unverified(repository, prNumber, headSha, null, "RUN_FETCH_FAILED", "could not read the workflow run");
  }
  if (!run) {
    return unverified(repository, prNumber, headSha, null, "RUN_NOT_FOUND", "no pr-agent workflow run found");
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    return unverified(repository, prNumber, headSha, run, "RUN_NOT_SUCCESS", `run ${run.id} is ${run.status}/${run.conclusion}`);
  }
  const runHead = typeof run.head_sha === "string" ? run.head_sha.toLowerCase() : "";
  if (runHead !== headSha.toLowerCase()) {
    return unverified(repository, prNumber, headSha, run, "STALE_RUN", `run head ${shortSha(run.head_sha)} does not match PR head ${shortSha(headSha)}`);
  }
  if (Array.isArray(run.pull_requests) && run.pull_requests.length > 0
    && !run.pull_requests.some((pr) => pr?.number === prNumber)) {
    return unverified(repository, prNumber, headSha, run, "RUN_MISMATCH", `run ${run.id} is not linked to PR ${prNumber}`);
  }

  let reviews;
  let comments;
  try {
    [reviews, comments] = await Promise.all([
      apiGet(fetchImpl, apiBaseUrl, `/repos/${repository}/pulls/${prNumber}/reviews?per_page=100`, token),
      apiGet(fetchImpl, apiBaseUrl, `/repos/${repository}/issues/${prNumber}/comments?per_page=100`, token),
    ]);
  } catch (error) {
    void error;
    return unverified(repository, prNumber, headSha, run, "EVIDENCE_FETCH_FAILED", "could not read reviews or comments");
  }

  return classifyPublication({ repository, prNumber, headSha, run, reviews, comments });
}

// Summary carries verdict codes and short SHAs only. Review bodies and tokens
// are never interpolated, and the whole text is capped, so appending it to
// GITHUB_STEP_SUMMARY cannot leak credentials or flood the log.
export function buildSummary(verdict) {
  const lines = [
    "### PR-Agent review verification",
    `- status: ${verdict.status}`,
    `- reason: ${verdict.reason}`,
    `- PR: ${verdict.repository}#${verdict.prNumber}`,
    `- head: ${shortSha(verdict.headSha)}`,
    `- run: ${verdict.runId ?? "unknown"}${verdict.runName ? ` (${verdict.runName})` : ""}`,
    `- detail: ${verdict.detail ?? ""}`,
    "- note: Advisory only. A human owns the merge decision.",
  ];
  return `${lines.join("\n")}\n`.slice(0, 4000);
}

function readEnv() {
  const repository = process.env.GITHUB_REPOSITORY?.trim() || null;
  const prRaw = process.env.PR_NUMBER ?? process.env.INPUT_PR_NUMBER ?? "";
  const runRaw = process.env.PR_AGENT_RUN_ID ?? "";
  return {
    repository,
    prNumber: prRaw === "" ? NaN : Number(prRaw),
    runId: runRaw.trim() === "" ? null : Number(runRaw),
    token: process.env.GITHUB_TOKEN?.trim() || null,
    summaryPath: process.env.GITHUB_STEP_SUMMARY?.trim() || null,
  };
}

async function main() {
  const { repository, prNumber, runId, token, summaryPath } = readEnv();
  if (!repository || !Number.isInteger(prNumber) || prNumber <= 0) {
    console.error("usage: GITHUB_REPOSITORY=owner/repo PR_NUMBER=<n> [PR_AGENT_RUN_ID=<id>] GITHUB_TOKEN=... verify-pr-agent-review.mjs");
    process.exit(2);
  }
  if (runId !== null && (!Number.isInteger(runId) || runId <= 0)) {
    console.error("PR_AGENT_RUN_ID must be a positive integer when set");
    process.exit(2);
  }
  if (!token) {
    console.error("GITHUB_TOKEN is required for live verification");
    process.exit(2);
  }
  const verdict = await verifyPrAgentReview({ repository, prNumber, runId, token });
  console.log(JSON.stringify(verdict, null, 2));
  if (summaryPath) {
    try {
      await appendFile(summaryPath, buildSummary(verdict), "utf8");
    } catch (error) {
      console.error(`could not append step summary: ${error instanceof Error ? error.message : error}`);
    }
  }
  process.exit(verdict.status === "UNVERIFIED" ? 1 : 0);
}

const invokedDirectly = typeof process.argv[1] === "string"
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}

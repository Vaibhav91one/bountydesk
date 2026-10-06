import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import type { SourceReader } from "@/lib/build-onboarding/classify";
import type { TrueForgeClient } from "@/lib/trueforge/client";

// The code review on a disposable schema: the turn is faked, the DB round-trip through the findings
// tool and the append-only trigger are real.
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let cr: typeof import("./code-review");
let review: typeof import("@/lib/mcp/review");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("code_review");
  dbm = await import("@/lib/db");
  cr = await import("./code-review");
  review = await import("@/lib/mcp/review");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;
async function reportRow(): Promise<string> {
  seq += 1;
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({ channel: "upload", sourceRef: `upload:cr-${seq}`, title: "t", body: "b", state: "ANALYSIS_ONLY" })
    .returning({ id: dbm.report.id });
  return row.id;
}

const source: SourceReader = { async readFile(path) { return path === "README.md" ? "# app" : null; } };
const finding = { file: "app.js", line: 3, category: "injection", summary: "eval of input", severity: "high", confidence: "medium" };

function fakeClient(reportFindings: boolean): TrueForgeClient {
  return {
    async createSession() { return { sessionId: "s1" }; },
    async createTurn(_s: string, events: Array<{ content: string }>) {
      if (reportFindings) {
        const token = /nothing else: (\S+)/.exec(events[0].content)![1];
        await review.reportCodeReviewFindings(token, [finding]);
      }
      return { turnId: "t1" };
    },
    async getTurn() { return { status: "done_no_action" }; },
    async deleteSession() {},
  } as unknown as TrueForgeClient;
}

test("findings from a run round-trip and the report state is untouched", async () => {
  const reportId = await reportRow();
  const status = await cr.runCodeReview(fakeClient(true), { reportId, repoFullName: "a/b", reportText: "x" }, { source });
  assert.equal(status, "DONE");
  const rows = await dbm.db.select().from(dbm.codeReviewFinding).where(dbm.eq(dbm.codeReviewFinding.reportId, reportId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].file, "app.js");
  assert.equal(rows[0].line, 3);
  assert.equal(rows[0].severity, "high");
  const [after] = await dbm.db.select({ state: dbm.report.state }).from(dbm.report).where(dbm.eq(dbm.report.id, reportId));
  assert.equal(after.state, "ANALYSIS_ONLY");
});

test("a finding cannot be updated or deleted", async () => {
  const reportId = await reportRow();
  await cr.runCodeReview(fakeClient(true), { reportId, repoFullName: "a/b", reportText: "x" }, { source });
  await assert.rejects(dbm.db.execute(`update code_review_finding set summary = 'x' where report_id = '${reportId}'`));
  await assert.rejects(dbm.db.execute(`delete from code_review_finding where report_id = '${reportId}'`));
});

test("an unknown token is refused and inserts nothing", async () => {
  const before = await dbm.db.select().from(dbm.codeReviewFinding);
  const result = await review.reportCodeReviewFindings("no-such-token", [finding]);
  assert.equal(result.ok, false);
  assert.equal((await dbm.db.select().from(dbm.codeReviewFinding)).length, before.length);
});

test("a failing turn is fail-open: FAILED status, no findings, no throw", async () => {
  const reportId = await reportRow();
  const broken = { async createSession() { throw new Error("down"); } } as unknown as TrueForgeClient;
  const status = await cr.runCodeReview(broken, { reportId, repoFullName: "a/b", reportText: "x" }, { source });
  assert.equal(status, "FAILED");
  const rows = await dbm.db.select().from(dbm.codeReviewFinding).where(dbm.eq(dbm.codeReviewFinding.reportId, reportId));
  assert.equal(rows.length, 0);
});

test("a token stops resolving once the run is over", async () => {
  const reportId = await reportRow();
  let token = "";
  const client = fakeClient(false);
  const origCreate = client.createTurn.bind(client) as (...a: unknown[]) => Promise<{ turnId: string }>;
  (client as unknown as { createTurn: unknown }).createTurn = async (s: string, events: Array<{ content: string }>, o: unknown) => {
    token = /nothing else: (\S+)/.exec(events[0].content)![1];
    return origCreate(s, events, o);
  };
  await cr.runCodeReview(client, { reportId, repoFullName: "a/b", reportText: "x" }, { source });
  assert.equal((await review.reportCodeReviewFindings(token, [finding])).ok, false);
});

function clientWithTurnStatus(turnStatus: string): TrueForgeClient {
  return { ...fakeClient(false), async getTurn() { return { status: turnStatus }; } } as unknown as TrueForgeClient;
}

test("an errored or cancelled turn is FAILED, not DONE", async () => {
  for (const turnStatus of ["error", "cancelled"]) {
    const reportId = await reportRow();
    const status = await cr.runCodeReview(clientWithTurnStatus(turnStatus), { reportId, repoFullName: "a/b", reportText: "x" }, { source });
    assert.equal(status, "FAILED");
  }
});

test("a turn that never finishes is TIMED_OUT, not DONE", async () => {
  const reportId = await reportRow();
  const status = await cr.runCodeReview(
    clientWithTurnStatus("running"),
    { reportId, repoFullName: "a/b", reportText: "x" },
    { source, deadlineMs: -1 },
  );
  assert.equal(status, "TIMED_OUT");
});

test("a clean turn with no findings is DONE", async () => {
  const reportId = await reportRow();
  const status = await cr.runCodeReview(clientWithTurnStatus("done_no_action"), { reportId, repoFullName: "a/b", reportText: "x" }, { source });
  assert.equal(status, "DONE");
});

test("enqueue returns at once, keeps one live run per report, and the worker claims it", async () => {
  const reportId = await reportRow();
  const first = await cr.enqueueCodeReview(reportId);
  assert.equal(await cr.enqueueCodeReview(reportId), first, "a second request reuses the live run");
  const [run] = await dbm.db.select().from(dbm.codeReviewRun).where(dbm.eq(dbm.codeReviewRun.id, first));
  assert.equal(run.status, "PENDING");

  // The report has no connected repository, so the claimed run fails and closes its token.
  assert.equal(await cr.runCodeReviewOnce(fakeClient(false)), first);
  const [done] = await dbm.db.select().from(dbm.codeReviewRun).where(dbm.eq(dbm.codeReviewRun.id, first));
  assert.equal(done.status, "FAILED");
  assert.equal(done.capabilityToken, `closed:${first}`);
  assert.equal(await cr.runCodeReviewOnce(fakeClient(false)), null, "nothing left to claim");
});

test("the sweeper times out a stale run and closes its token, and leaves a fresh one", async () => {
  const staleReport = await reportRow();
  const freshReport = await reportRow();
  const [stale] = await dbm.db
    .insert(dbm.codeReviewRun)
    .values({ reportId: staleReport, capabilityToken: "stale-token", status: "RUNNING", createdAt: new Date(Date.now() - 30 * 60_000), startedAt: new Date(Date.now() - 30 * 60_000) })
    .returning({ id: dbm.codeReviewRun.id });
  const [fresh] = await dbm.db
    .insert(dbm.codeReviewRun)
    .values({ reportId: freshReport, capabilityToken: "fresh-token", status: "RUNNING" })
    .returning({ id: dbm.codeReviewRun.id });
  assert.equal(await cr.sweepStaleCodeReviews(), 1);
  const rows = await dbm.db.select().from(dbm.codeReviewRun);
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get(stale.id)!.status, "TIMED_OUT");
  assert.equal(byId.get(stale.id)!.capabilityToken, `closed:${stale.id}`);
  assert.equal(byId.get(fresh.id)!.status, "RUNNING");
  assert.equal((await review.reportCodeReviewFindings("stale-token", [finding])).ok, false);
});

test("concurrent enqueues for one report leave exactly one live run", async () => {
  const reportId = await reportRow();
  const ids = await Promise.all(Array.from({ length: 6 }, () => cr.enqueueCodeReview(reportId)));
  assert.equal(new Set(ids).size, 1);
  const rows = await dbm.db.select().from(dbm.codeReviewRun).where(dbm.eq(dbm.codeReviewRun.reportId, reportId));
  assert.equal(rows.length, 1);
});

test("a run started recently is not swept even if it was queued long ago", async () => {
  const reportId = await reportRow();
  const [run] = await dbm.db
    .insert(dbm.codeReviewRun)
    .values({ reportId, capabilityToken: "waited-token", status: "RUNNING", createdAt: new Date(Date.now() - 60 * 60_000), startedAt: new Date() })
    .returning({ id: dbm.codeReviewRun.id });
  await cr.sweepStaleCodeReviews();
  const [row] = await dbm.db.select().from(dbm.codeReviewRun).where(dbm.eq(dbm.codeReviewRun.id, run.id));
  assert.equal(row.status, "RUNNING");
  assert.equal(row.capabilityToken, "waited-token");
});

test("a stale PENDING run that was never claimed is swept", async () => {
  const reportId = await reportRow();
  const [run] = await dbm.db
    .insert(dbm.codeReviewRun)
    .values({ reportId, capabilityToken: "never-claimed", status: "PENDING", createdAt: new Date(Date.now() - 60 * 60_000) })
    .returning({ id: dbm.codeReviewRun.id });
  await cr.sweepStaleCodeReviews();
  const [row] = await dbm.db.select().from(dbm.codeReviewRun).where(dbm.eq(dbm.codeReviewRun.id, run.id));
  assert.equal(row.status, "TIMED_OUT");
});

test("neither the sweeper nor the worker overwrites the other's terminal write", async () => {
  // The sweeper wins: the turn is still running when its run is swept, then finishes DONE.
  const reportId = await reportRow();
  const old = new Date(Date.now() - 60 * 60_000);
  const [run] = await dbm.db
    .insert(dbm.codeReviewRun)
    .values({ reportId, capabilityToken: "race-token", status: "RUNNING", createdAt: old, startedAt: old })
    .returning({ id: dbm.codeReviewRun.id });
  await cr.sweepStaleCodeReviews();
  await cr.closeRun(run.id, "race-token", "DONE");
  const [swept] = await dbm.db.select().from(dbm.codeReviewRun).where(dbm.eq(dbm.codeReviewRun.id, run.id));
  assert.equal(swept.status, "TIMED_OUT", "a late close does not overwrite the sweeper");

  // The worker wins: a finished run is not touched by a later sweep.
  const second = await reportRow();
  const [done] = await dbm.db
    .insert(dbm.codeReviewRun)
    .values({ reportId: second, capabilityToken: "done-token", status: "RUNNING", createdAt: old, startedAt: old })
    .returning({ id: dbm.codeReviewRun.id });
  await cr.closeRun(done.id, "done-token", "DONE");
  await cr.sweepStaleCodeReviews();
  const [kept] = await dbm.db.select().from(dbm.codeReviewRun).where(dbm.eq(dbm.codeReviewRun.id, done.id));
  assert.equal(kept.status, "DONE");
});

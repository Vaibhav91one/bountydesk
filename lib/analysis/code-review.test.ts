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

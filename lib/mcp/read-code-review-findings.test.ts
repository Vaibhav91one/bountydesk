import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let mod: typeof import("./read-code-review-findings");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("read_cr_findings");
  dbm = await import("@/lib/db");
  mod = await import("./read-code-review-findings");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

async function seed(summaries: string[]): Promise<{ reportId: string; capability: string }> {
  seq += 1;
  const [r] = await dbm.db
    .insert(dbm.report)
    .values({ channel: "github", sourceRef: `github:1:issue:${seq}`, title: `r${seq}`, body: "b", state: "REPRODUCING" })
    .returning({ id: dbm.report.id });
  const capability = `cap-${seq}-${randomUUID()}`;
  await dbm.db.insert(dbm.agentSession).values({ reportId: r.id, capabilityToken: capability, sessionId: `s-${seq}` });
  for (const summary of summaries) {
    await dbm.db.insert(dbm.codeReviewFinding).values({
      reportId: r.id,
      file: "src/a.ts",
      line: 3,
      category: "injection",
      summary,
      severity: "high",
      confidence: "medium",
    });
  }
  return { reportId: r.id, capability };
}

async function counts() {
  const [f] = await dbm.db.execute<{ n: string }>("select count(*)::text as n from code_review_finding");
  const [r] = await dbm.db.execute<{ s: string }>("select string_agg(id::text || state, ',' order by id) as s from report");
  return { findings: f.n, reports: r.s };
}

test("a valid capability returns its own report's findings", async () => {
  const { capability } = await seed(["first", "second"]);
  const res = await mod.readCodeReviewFindings({ capability });
  assert.ok(res.ok);
  assert.deepEqual(res.findings.map((f) => f.summary).sort(), ["first", "second"]);
});

test("an unknown capability is an error with no data", async () => {
  await seed(["x"]);
  const res = await mod.readCodeReviewFindings({ capability: "nope" });
  assert.deepEqual(res, { ok: false, reason: "unknown capability" });
});

test("another report's findings are never returned", async () => {
  const a = await seed(["mine"]);
  await seed(["theirs"]);
  const res = await mod.readCodeReviewFindings({ capability: a.capability });
  assert.ok(res.ok);
  assert.deepEqual(res.findings.map((f) => f.summary), ["mine"]);
});

test("a report with no findings returns an empty list", async () => {
  const { capability } = await seed([]);
  assert.deepEqual(await mod.readCodeReviewFindings({ capability }), { ok: true, findings: [] });
});

test("reading writes nothing", async () => {
  const { capability } = await seed(["x"]);
  const before = await counts();
  await mod.readCodeReviewFindings({ capability });
  await mod.readCodeReviewFindings({ capability: "nope" });
  assert.deepEqual(await counts(), before);
});

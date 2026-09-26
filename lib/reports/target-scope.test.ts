import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let scope: typeof import("./target-scope");
let lifecycle: typeof import("./lifecycle");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("target_scope");
  dbm = await import("@/lib/db");
  scope = await import("./target-scope");
  lifecycle = await import("./lifecycle");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

async function seedReport(state: "TRIAGING" | "REPRODUCING" = "TRIAGING"): Promise<string> {
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:1:issue:${randomUUID()}`,
      title: "t",
      body: "b",
      state,
    })
    .returning({ id: dbm.report.id });
  return row.id;
}

async function recordFallback(reportId: string, reason: string, sourceFiles: string[]) {
  await lifecycle.recordEvent(reportId, "reproduction.static_fallback", { reason, ref: null, sourceFiles });
}

function route(reportId: string) {
  return dbm.db.transaction((tx) => scope.routeUnreproducibleTarget(reportId, tx));
}

async function stateOf(id: string): Promise<string> {
  const [row] = await dbm.db.select({ state: dbm.report.state }).from(dbm.report).where(dbm.eq(dbm.report.id, id));
  return row.state;
}

test("a static fallback that read no source lands OUT_OF_SCOPE with a target.out_of_scope event", async () => {
  const reportId = await seedReport();
  await recordFallback(reportId, "COULD_NOT_DEPLOY", []);

  assert.deepEqual(await route(reportId), { routed: true });
  assert.equal(await stateOf(reportId), "OUT_OF_SCOPE");

  const events = await dbm.db
    .select({ data: dbm.sessionEvent.data })
    .from(dbm.sessionEvent)
    .where(dbm.and(dbm.eq(dbm.sessionEvent.reportId, reportId), dbm.eq(dbm.sessionEvent.type, "target.out_of_scope")));
  assert.equal(events.length, 1);
  assert.equal((events[0].data as { reason: string }).reason, "COULD_NOT_DEPLOY");
});

test("a report with no static fallback is never routed, so absence of a target is never OUT_OF_SCOPE", async () => {
  const reportId = await seedReport();
  assert.deepEqual(await route(reportId), { routed: false, reason: "no-static-fallback" });
  assert.equal(await stateOf(reportId), "TRIAGING");
});

test("a static review that read source stays on the ANALYSIS_ONLY path", async () => {
  const reportId = await seedReport();
  await recordFallback(reportId, "COULD_NOT_BUILD", ["routes/search.js"]);
  assert.deepEqual(await route(reportId), { routed: false, reason: "source-was-read" });
  assert.equal(await stateOf(reportId), "TRIAGING");
});

test("a report that already has a verdict is not routed", async () => {
  const reportId = await seedReport();
  await recordFallback(reportId, "COULD_NOT_BUILD", []);
  await dbm.db.insert(dbm.verdict).values({
    reportId,
    outcome: "ANALYSIS_ONLY",
    summary: "s",
    payload: `p-${reportId}`,
    contentHash: `h-${reportId}`,
  });
  assert.deepEqual(await route(reportId), { routed: false, reason: "has-verdict" });
});

test("a report that has already left TRIAGING is left alone", async () => {
  const reportId = await seedReport("REPRODUCING");
  await recordFallback(reportId, "COULD_NOT_DEPLOY", []);
  assert.deepEqual(await route(reportId), { routed: false, reason: "not-triaging" });
  assert.equal(await stateOf(reportId), "REPRODUCING");
});

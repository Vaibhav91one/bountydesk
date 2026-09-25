import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let scope: typeof import("./target-scope");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("target_scope");
  dbm = await import("@/lib/db");
  scope = await import("./target-scope");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

async function targetProfile(): Promise<string> {
  const [row] = await dbm.db
    .insert(dbm.targetProfile)
    .values({
      name: `target-${randomUUID()}`,
      imageName: "ghcr.io/x/app",
      imageDigest: `sha256:${"a".repeat(64)}`,
      snapshotId: "snap-1",
    })
    .returning({ id: dbm.targetProfile.id });
  return row.id;
}

async function seedReport(
  targetProfileId: string | null,
  state: "TRIAGING" | "REPRODUCING" = "TRIAGING",
): Promise<string> {
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:1:issue:${randomUUID()}`,
      title: "t",
      body: "b",
      connectedRepositoryId: null,
      targetProfileId,
      state,
    })
    .returning({ id: dbm.report.id });
  return row.id;
}

async function stateOf(id: string): Promise<string> {
  const [row] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, id));
  return row.state;
}

test("a bound TRIAGING report lands OUT_OF_SCOPE with a target.out_of_scope event", async () => {
  const reportId = await seedReport(await targetProfile());

  const result = await scope.routeUnreproducibleTarget(reportId, "target could not be deployed");

  assert.deepEqual(result, { routed: true });
  assert.equal(await stateOf(reportId), "OUT_OF_SCOPE");

  const events = await dbm.db
    .select({ type: dbm.sessionEvent.type, data: dbm.sessionEvent.data })
    .from(dbm.sessionEvent)
    .where(dbm.eq(dbm.sessionEvent.reportId, reportId));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "target.out_of_scope");
  assert.equal((events[0].data as { reason: string }).reason, "target could not be deployed");
});

test("a report with no bound target is never routed to OUT_OF_SCOPE", async () => {
  const reportId = await seedReport(null);

  const result = await scope.routeUnreproducibleTarget(reportId, "should not apply");

  assert.deepEqual(result, { routed: false, reason: "no-bound-target" });
  assert.equal(await stateOf(reportId), "TRIAGING", "no target means it stays for the analysis-only run");
});

test("a bound report that has already left TRIAGING is left alone", async () => {
  const reportId = await seedReport(await targetProfile(), "REPRODUCING");

  const result = await scope.routeUnreproducibleTarget(reportId, "too late");

  assert.deepEqual(result, { routed: false, reason: "not-triaging" });
  assert.equal(await stateOf(reportId), "REPRODUCING");
});

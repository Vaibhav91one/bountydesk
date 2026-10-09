import assert from "node:assert/strict";
import test, { after, before } from "node:test";

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let exportModule: typeof import("./export");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("reports_export");
  dbm = await import("@/lib/db");
  exportModule = await import("./export");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

async function seedReport(): Promise<string> {
  seq += 1;
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:1:issue:${seq}`,
      title: `report ${seq}`,
      body: "the reporter's own words",
      state: "AWAITING_APPROVAL",
    })
    .returning({ id: dbm.report.id });
  return row.id;
}

test("a report with no verdict at all has nothing to export", async () => {
  const id = await seedReport();
  const result = await exportModule.renderReportExport(id);
  assert.deepEqual(result, { ok: false, reason: "not_found" });
});

test("a drafted but unapproved verdict is refused, not exported", async () => {
  const id = await seedReport();
  await dbm.db.insert(dbm.verdict).values({
    reportId: id,
    outcome: "REPRODUCED",
    summary: "sql injection",
    payload: "## Outcome: REPRODUCED\n\nthe exact comment",
    contentHash: `hash-${id}`,
  });

  const result = await exportModule.renderReportExport(id);
  assert.deepEqual(result, { ok: false, reason: "not_found" });
});

test("an approved verdict bundles the payload, findings and transcript into one document", async () => {
  const id = await seedReport();
  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: id,
      outcome: "REPRODUCED",
      summary: "sql injection",
      payload: "## Outcome: REPRODUCED\n\nthe exact approved comment",
      contentHash: `hash-${id}`,
      evidence: {
        source: "agent-drafted",
        findings: [
          {
            title: "SQL injection in search",
            severity: "high",
            description: "a crafted q parameter",
            evidenceRef: "/opt/tf/artifacts/evidence.json",
          },
        ],
      },
    })
    .returning({ id: dbm.verdict.id });

  await dbm.db.insert(dbm.sessionEvent).values({
    reportId: id,
    seq: 1,
    type: "agent.tool_call:http_probe",
    data: { toolName: "http_probe", argumentsPreview: '{"url":"/rest/products"}' },
  });

  await dbm.db.insert(dbm.approvalDecision).values({
    verdictId: v.id,
    reviewer: "reviewer@example.com",
    decision: "APPROVED",
    payloadHash: `hash-${id}`,
  });

  const result = await exportModule.renderReportExport(id);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.match(result.markdown, /the exact approved comment/);
  assert.match(result.markdown, /SQL injection in search/);
  assert.match(result.markdown, /http_probe/);
  assert.match(result.markdown, new RegExp(`hash-${id}`));
  assert.equal(result.filename, `bountydesk-${id.slice(0, 8)}-r1.md`);
});

test("a denied verdict is refused the same as an unapproved one", async () => {
  const id = await seedReport();
  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: id,
      outcome: "NOT_REPRODUCED",
      summary: "not reproduced",
      payload: "not reproduced",
      contentHash: `hash-${id}`,
    })
    .returning({ id: dbm.verdict.id });

  await dbm.db.insert(dbm.approvalDecision).values({
    verdictId: v.id,
    reviewer: "reviewer@example.com",
    decision: "DENIED",
    payloadHash: `hash-${id}`,
  });

  const result = await exportModule.renderReportExport(id);
  assert.deepEqual(result, { ok: false, reason: "not_found" });
});

test("an id that matches nothing is not found", async () => {
  const result = await exportModule.renderReportExport(
    "00000000-0000-0000-0000-000000000000",
  );
  assert.deepEqual(result, { ok: false, reason: "not_found" });
});

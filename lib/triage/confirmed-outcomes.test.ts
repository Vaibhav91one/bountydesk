import assert from "node:assert/strict";
import test, { after, before } from "node:test";

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let mod: typeof import("./confirmed-outcomes");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("confirmed_outcomes");
  dbm = await import("@/lib/db");
  mod = await import("./confirmed-outcomes");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

async function seedVerdict(): Promise<{ reportId: string; verdictId: string }> {
  seq += 1;
  const [r] = await dbm.db
    .insert(dbm.report)
    .values({ channel: "github", sourceRef: `github:1:issue:${seq}`, title: `r${seq}`, body: "b" })
    .returning({ id: dbm.report.id });

  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: r.id,
      outcome: "REPRODUCED",
      summary: "s",
      payload: "p",
      contentHash: `hash-${seq}`,
    })
    .returning({ id: dbm.verdict.id });

  return { reportId: r.id, verdictId: v.id };
}

test("a verdict with no decision never appears in the sample", async () => {
  await seedVerdict();
  const sample = await mod.confirmedOutcomeSample();
  assert.equal(sample.length, 0);
});

test("an approved and a denied verdict both appear; only the decided ones do", async () => {
  const approved = await seedVerdict();
  await dbm.db.insert(dbm.approvalDecision).values({
    verdictId: approved.verdictId,
    reviewer: "reviewer@example.com",
    decision: "APPROVED",
    payloadHash: "hash-x",
  });

  const denied = await seedVerdict();
  await dbm.db.insert(dbm.approvalDecision).values({
    verdictId: denied.verdictId,
    reviewer: "reviewer@example.com",
    decision: "DENIED",
    payloadHash: "hash-y",
  });

  // An undecided verdict seeded alongside the two above must not leak into the sample.
  await seedVerdict();

  const sample = await mod.confirmedOutcomeSample();
  const byVerdict = new Map(sample.map((row) => [row.verdictId, row]));

  assert.equal(sample.length, 2, "only the two decided verdicts should appear");
  assert.equal(byVerdict.get(approved.verdictId)?.decision, "APPROVED");
  assert.equal(byVerdict.get(denied.verdictId)?.decision, "DENIED");
});

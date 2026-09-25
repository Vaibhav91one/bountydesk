import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Imported dynamically, after createSchema has set DATABASE_SCHEMA: lifecycle.ts pulls in @/lib/db,
 * which builds its pool at import time, so a static import would bind the pool to the wrong schema.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let lifecycle: typeof import("./lifecycle");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("reports_lifecycle");
  dbm = await import("@/lib/db");
  lifecycle = await import("./lifecycle");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

/** Seed an email report that arrived from a verified outside sender. Returns its id. */
async function seedParent(sender: string): Promise<{ id: string; messageId: string }> {
  seq += 1;
  const messageId = `<parent-${seq}@mail.test>`;
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "email",
      sourceRef: `email:${messageId}`,
      title: `report ${seq}`,
      body: "the reporter's own words",
      reporterContact: sender,
      verifiedSender: sender,
      state: "NEEDS_DECISION",
      connectedRepositoryId: null,
      targetProfileId: null,
    })
    .returning({ id: dbm.report.id });
  return { id: row.id, messageId };
}

test("a reply threaded to a parent with the same verified sender links to it", async () => {
  const sender = "ada@example.com";
  const parent = await seedParent(sender);
  const linked = await lifecycle.findRepliedToReport(
    ["<unknown@mail.test>", parent.messageId],
    sender,
  );
  assert.equal(linked, parent.id);
});

test("a reply from a different verified sender does not link", async () => {
  const parent = await seedParent("ada@example.com");
  const linked = await lifecycle.findRepliedToReport([parent.messageId], "mallory@example.com");
  assert.equal(linked, null);
});

test("a reply with no matching token does not link", async () => {
  const sender = "grace@example.com";
  await seedParent(sender);
  const linked = await lifecycle.findRepliedToReport(["<nothing-matches@mail.test>"], sender);
  assert.equal(linked, null);
});

test("no tokens and no verified sender both short-circuit to null", async () => {
  const parent = await seedParent("hopper@example.com");
  assert.equal(await lifecycle.findRepliedToReport([], "hopper@example.com"), null);
  assert.equal(await lifecycle.findRepliedToReport([parent.messageId], null), null);
});

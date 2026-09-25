import assert from "node:assert/strict";
import test, { after, before, mock } from "node:test";

/**
 * The config table and its owner-only server action. The read half runs against a real disposable
 * schema, because "no row means defaults" is a database fact. The mutation half is what the security
 * test is about: only an owner may change the limits, and junk is refused rather than clamped.
 *
 * The DAL is mocked (not Clerk underneath it) so this never loads @clerk/nextjs/server, which has no
 * request scope in a plain node:test process. This needs --experimental-test-module-mocks, which the
 * test script carries. next/cache is mocked so revalidatePath is a no-op here.
 */
const OWNER = "owner@bountydesk.test";
process.env.REVIEWER_EMAILS = OWNER;

let session: { email: string } | null = { email: OWNER };
mock.module("@/lib/auth/dal", {
  namedExports: {
    requireReviewer: async () => {
      if (session) return session;
      const { redirect } = await import("next/navigation");
      redirect("/login");
    },
  },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let config: typeof import("./outside-config");
let actions: typeof import("@/app/(app)/integrations/email-config-actions");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("outside_config");
  dbm = await import("@/lib/db");
  config = await import("./outside-config");
  actions = await import("@/app/(app)/integrations/email-config-actions");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

test("readOutsideConfig returns the built-in defaults when the table is empty", async () => {
  assert.deepEqual(await config.readOutsideConfig(), config.outsideConfigDefaults());
});

test("an owner can save valid limits, and the row round-trips lowercased and de-duplicated", async () => {
  session = { email: OWNER };
  const result = await actions.saveOutsideConfig({
    perSenderPerDay: 3,
    perDomainPerDay: 10,
    maxBytes: 256 * 1024,
    exemptDomains: ["  GMAIL.com ", "gmail.com", "Proton.me"],
  });
  assert.deepEqual(result, { ok: true });

  const saved = await config.readOutsideConfig();
  assert.equal(saved.perSenderPerDay, 3);
  assert.equal(saved.perDomainPerDay, 10);
  assert.equal(saved.maxBytes, 256 * 1024);
  assert.deepEqual(saved.exemptDomains, ["gmail.com", "proton.me"]);
});

test("two saves converge on one row, the second value wins, and the read is deterministic", async () => {
  // Two writes stand in for two concurrent owners or a retried request. The fixed-id singleton plus
  // onConflictDoUpdate must leave exactly one row rather than racing into two that the read could
  // pick between arbitrarily.
  await config.upsertOutsideConfig(
    { perSenderPerDay: 7, perDomainPerDay: 30, maxBytes: 100 * 1024, exemptDomains: ["one.test"] },
    OWNER,
  );
  await config.upsertOutsideConfig(
    { perSenderPerDay: 9, perDomainPerDay: 40, maxBytes: 200 * 1024, exemptDomains: ["two.test"] },
    OWNER,
  );

  const rows = await dbm.db.select().from(dbm.outsideIntakeConfig);
  assert.equal(rows.length, 1, "the config table holds exactly one row");

  const read = await config.readOutsideConfig();
  assert.equal(read.perSenderPerDay, 9);
  assert.equal(read.perDomainPerDay, 40);
  assert.equal(read.maxBytes, 200 * 1024);
  assert.deepEqual(read.exemptDomains, ["two.test"]);
});

test("a non-owner cannot change the limits", async () => {
  session = { email: "member@bountydesk.test" };
  const result = await actions.saveOutsideConfig({
    perSenderPerDay: 99,
    perDomainPerDay: 99,
    maxBytes: 1024,
    exemptDomains: [],
  });
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /owner/i);
});

test("validation refuses junk numbers and malformed domains", async () => {
  session = { email: OWNER };
  const base = { perSenderPerDay: 5, perDomainPerDay: 20, maxBytes: 512 * 1024, exemptDomains: [] as string[] };

  const bad = [
    { ...base, perSenderPerDay: 0 },
    { ...base, perSenderPerDay: -1 },
    { ...base, perDomainPerDay: 5000 },
    { ...base, perSenderPerDay: 2.5 },
    { ...base, maxBytes: 10 },
    { ...base, maxBytes: 50 * 1024 * 1024 },
    { ...base, maxBytes: Number.NaN },
    { ...base, exemptDomains: ["not a domain"] },
    { ...base, exemptDomains: ["nodot"] },
    { ...base, exemptDomains: ["-leadinghyphen.com"] },
  ];

  for (const values of bad) {
    const result = await actions.saveOutsideConfig(values);
    assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(values)}`);
  }
});

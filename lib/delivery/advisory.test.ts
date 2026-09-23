import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

/**
 * The owner advisory sends an approved verdict to a second audience, so what is under test is
 * everything that can stop it: the request gates, the approved hash and marker at send time, a
 * grant revoked after the click, and a crashed attempt that must not open a second advisory.
 * GitHub is faked; every gate is a row, so the database is real.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let advisory: typeof import("./advisory");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("owner_advisory");
  dbm = await import("@/lib/db");
  advisory = await import("./advisory");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

// adviseOnce claims globally, so nothing a previous test left pending may be handed to the next.
beforeEach(async () => {
  await dbm.db
    .update(dbm.ownerAdvisory)
    .set({ state: "FAILED" })
    .where(dbm.eq(dbm.ownerAdvisory.state, "PENDING"));
});

const fakeHash = (payload: string) => `fake:${payload.length}:${payload.slice(0, 16)}`;
const REPORTER = "reporter@example.test";

let seq = 0;

type Fixture = {
  channel?: "email" | "github";
  state?: string;
  outcome?: "REPRODUCED" | "NOT_REPRODUCED" | "ANALYSIS_ONLY";
  repo?: boolean;
  delivered?: boolean;
  payload?: (marker: string) => string;
};

async function seed(opts: Fixture = {}) {
  seq += 1;
  const n = seq;
  const [profile] = await dbm.db
    .insert(dbm.targetProfile)
    .values({ name: `adv-${n}`, imageDigest: `sha256:adv-${n}` })
    .returning({ id: dbm.targetProfile.id });
  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({ installationId: 100 + n, accountLogin: `acme-${n}`, accountId: 200 + n, accountType: "User" })
    .returning({ id: dbm.githubInstallation.id });
  const [repo] = await dbm.db
    .insert(dbm.connectedRepository)
    .values({ installationId: installation.id, repoId: 300 + n, fullName: `acme-${n}/app`, targetProfileId: profile.id })
    .returning({ id: dbm.connectedRepository.id });

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: opts.channel ?? "email",
      sourceRef: `email:<adv-${n}@mail.example>`,
      title: `XSS in search\r\nreport ${n}`,
      body: "body",
      state: (opts.state ?? "DELIVERED") as never,
      reporterContact: REPORTER,
      connectedRepositoryId: opts.repo === false ? null : repo.id,
      targetProfileId: profile.id,
    })
    .returning({ id: dbm.report.id });

  const verdictId = randomUUID();
  const marker = `<!-- bountydesk-delivery:${verdictId} -->`;
  const payload = opts.payload ? opts.payload(marker) : `Reproduced.\n${marker}`;
  await dbm.db.insert(dbm.verdict).values({
    id: verdictId,
    reportId: r.id,
    outcome: opts.outcome ?? "REPRODUCED",
    summary: "summary",
    payload,
    contentHash: fakeHash(payload),
  });
  await dbm.db.insert(dbm.outboundDelivery).values({
    reportId: r.id,
    verdictId,
    idempotencyKey: `verdict:${verdictId}`,
    target: REPORTER,
    approvedContentHash: fakeHash(payload),
    state: "SENT",
    deliveredAt: opts.delivered === false ? null : new Date(),
  });
  return { reportId: r.id, verdictId, marker, payload, repoId: repo.id, installationId: installation.id };
}

function fakeGitHub(opts: { existing?: boolean; createError?: { status: number } } = {}) {
  const calls = { create: [] as { fullName: string; summary: string; description: string }[], mint: 0 };
  const deps: import("./advisory").AdvisoryDeps = {
    hashContent: fakeHash,
    mintToken: async () => {
      calls.mint += 1;
      return { token: "t" };
    },
    findByMarker: async () =>
      opts.existing ? { ghsaId: "GHSA-old", htmlUrl: "https://github.com/x/y/security/advisories/GHSA-old" } : null,
    create: async (input) => {
      if (opts.createError) {
        throw Object.assign(new Error(`status ${opts.createError.status}`), opts.createError);
      }
      calls.create.push(input);
      return { ghsaId: "GHSA-new", htmlUrl: "https://github.com/x/y/security/advisories/GHSA-new" };
    },
  };
  return { deps, calls };
}

async function row(reportId: string) {
  const [r] = await dbm.db.select().from(dbm.ownerAdvisory).where(dbm.eq(dbm.ownerAdvisory.reportId, reportId));
  return r;
}

test("a request is refused unless the report is a delivered, reproduced email report with a live repo", async () => {
  const cases: [Fixture, RegExp][] = [
    [{ channel: "github" }, /only an email report/],
    [{ state: "DELIVERING" }, /reach the reporter first/],
    [{ repo: false }, /no connected repository/],
    [{ outcome: "NOT_REPRODUCED" }, /only a reproduced verdict/],
    [{ delivered: false }, /no delivered verdict/],
  ];
  for (const [fixture, reason] of cases) {
    const { reportId } = await seed(fixture);
    const result = await advisory.requestOwnerAdvisory(reportId, "reviewer");
    assert.equal(result.ok, false, JSON.stringify(fixture));
    assert.match((result as { reason: string }).reason, reason);
    assert.equal(await row(reportId), undefined);
  }
});

test("a request is refused once the repository's grant is revoked, and only one is ever recorded", async () => {
  const revoked = await seed();
  await dbm.db
    .update(dbm.connectedRepository)
    .set({ active: false })
    .where(dbm.eq(dbm.connectedRepository.id, revoked.repoId));
  assert.deepEqual(await advisory.requestOwnerAdvisory(revoked.reportId, "r"), {
    ok: false,
    reason: "the repository no longer grants access",
  });

  const live = await seed();
  assert.deepEqual(await advisory.requestOwnerAdvisory(live.reportId, "r"), { ok: true });
  assert.match(
    (await advisory.requestOwnerAdvisory(live.reportId, "r") as { reason: string }).reason,
    /already been notified/,
  );
});

test("the sender opens a draft carrying the approved payload, and nothing about the reporter", async () => {
  const { reportId, payload } = await seed();
  await advisory.requestOwnerAdvisory(reportId, "r");
  const { deps, calls } = fakeGitHub();

  assert.ok(await advisory.adviseOnce({ deps }));
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].description, payload);
  assert.equal(calls.create[0].summary.includes("\n"), false);
  assert.equal(JSON.stringify(calls.create[0]).includes(REPORTER), false);

  const r = await row(reportId);
  assert.equal(r.state, "SENT");
  assert.equal(r.ghsaId, "GHSA-new");
  assert.equal(await advisory.adviseOnce({ deps }), null, "nothing left to send");
});

test("an advisory an earlier attempt already opened is found by its marker, not opened twice", async () => {
  const { reportId } = await seed();
  await advisory.requestOwnerAdvisory(reportId, "r");
  const { deps, calls } = fakeGitHub({ existing: true });

  await advisory.adviseOnce({ deps });
  assert.equal(calls.create.length, 0);
  assert.equal((await row(reportId)).ghsaId, "GHSA-old");
});

test("a payload whose hash no longer matches the approval is never sent", async () => {
  const { reportId } = await seed();
  await advisory.requestOwnerAdvisory(reportId, "r");
  const { deps, calls } = fakeGitHub();

  await advisory.adviseOnce({ deps: { ...deps, hashContent: () => "tampered" } });
  assert.equal(calls.mint, 0);
  assert.equal((await row(reportId)).state, "FAILED");
});

test("a payload with its marker missing or doubled is never sent", async () => {
  for (const payload of [() => "no marker", (m: string) => `${m}\n${m}`]) {
    const { reportId } = await seed({ payload });
    await advisory.requestOwnerAdvisory(reportId, "r");
    const { deps, calls } = fakeGitHub();
    await advisory.adviseOnce({ deps });
    assert.equal(calls.mint, 0);
    assert.match((await row(reportId)).lastError ?? "", /marker/);
  }
});

test("a grant revoked after the request stops the send before a token is minted", async () => {
  const { reportId, installationId } = await seed();
  await advisory.requestOwnerAdvisory(reportId, "r");
  await dbm.db
    .update(dbm.githubInstallation)
    .set({ suspendedAt: new Date() })
    .where(dbm.eq(dbm.githubInstallation.id, installationId));
  const { deps, calls } = fakeGitHub();

  await advisory.adviseOnce({ deps });
  assert.equal(calls.mint, 0);
  assert.match((await row(reportId)).lastError ?? "", /no longer connected/);
});

test("GitHub refusing the advisory fails for good, an outage is retried later", async () => {
  const refused = await seed();
  await advisory.requestOwnerAdvisory(refused.reportId, "r");
  await advisory.adviseOnce({ deps: fakeGitHub({ createError: { status: 403 } }).deps });
  assert.equal((await row(refused.reportId)).state, "FAILED");

  // Once the owner accepts the permission, a reviewer can ask again and it goes through.
  assert.deepEqual(await advisory.requestOwnerAdvisory(refused.reportId, "r"), { ok: true });
  assert.equal((await row(refused.reportId)).state, "PENDING");
  await advisory.adviseOnce({ deps: fakeGitHub().deps });
  assert.equal((await row(refused.reportId)).state, "SENT");
  assert.match(
    (await advisory.requestOwnerAdvisory(refused.reportId, "r") as { reason: string }).reason,
    /already been notified/,
  );

  const outage = await seed();
  await advisory.requestOwnerAdvisory(outage.reportId, "r");
  await advisory.adviseOnce({ deps: fakeGitHub({ createError: { status: 502 } }).deps });
  const r = await row(outage.reportId);
  assert.equal(r.state, "PENDING");
  assert.equal(r.attempts, 1);
  assert.ok(r.nextAttemptAt.getTime() > Date.now(), "not claimable again straight away");
});

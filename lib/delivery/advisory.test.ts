import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

/**
 * The owner advisory sends an approved verdict to a second audience, so what is under test is
 * everything that can stop it: the request gates, the approved hash and marker at send time, a
 * grant revoked after the click, and a crashed attempt or a later revision that must update the
 * one advisory rather than open a second.
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
  channel?: "email" | "github" | "manual";
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

  const first = await addRevision(r.id, 1, opts);
  return { reportId: r.id, ...first, repoId: repo.id, installationId: installation.id };
}

/** A verdict revision and the delivery that took it to the reporter. */
async function addRevision(reportId: string, revision: number, opts: Fixture = {}) {
  const verdictId = randomUUID();
  const marker = `<!-- bountydesk-delivery:${verdictId} -->`;
  const payload = opts.payload ? opts.payload(marker) : `Reproduced, revision ${revision}.\n${marker}`;
  await dbm.db.insert(dbm.verdict).values({
    id: verdictId,
    reportId,
    outcome: opts.outcome ?? "REPRODUCED",
    summary: "summary",
    evidence: {
      source: "agent-drafted",
      findings: [
        { title: "Reflected XSS in search", severity: "medium", description: "d", evidenceRef: "r" },
        { title: "Login bypass", severity: "high", description: "An SQL injection, CWE-89.", evidenceRef: "r" },
      ],
    },
    payload,
    contentHash: fakeHash(payload),
    revision,
  });
  await dbm.db.insert(dbm.outboundDelivery).values({
    reportId,
    verdictId,
    idempotencyKey: `verdict:${verdictId}`,
    target: REPORTER,
    approvedContentHash: fakeHash(payload),
    state: "SENT",
    deliveredAt: opts.delivered === false ? null : new Date(),
  });
  return { verdictId, marker, payload };
}

type CreateInput = Parameters<import("./advisory").AdvisoryDeps["create"]>[0];
type UpdateInput = Parameters<import("./advisory").AdvisoryDeps["update"]>[0];

function fakeGitHub(opts: { existing?: string; createError?: { status: number } } = {}) {
  const calls = { create: [] as CreateInput[], update: [] as UpdateInput[], markers: [] as string[][], mint: 0 };
  const url = (id: string) => `https://github.com/x/y/security/advisories/${id}`;
  const deps: import("./advisory").AdvisoryDeps = {
    hashContent: fakeHash,
    mintToken: async () => {
      calls.mint += 1;
      return { token: "t" };
    },
    // `existing` is the marker an advisory already on GitHub carries.
    findByMarker: async ({ markers }) => {
      calls.markers.push(markers);
      return opts.existing && markers.includes(opts.existing)
        ? { ghsaId: "GHSA-old", htmlUrl: url("GHSA-old"), marker: opts.existing }
        : null;
    },
    create: async (input) => {
      if (opts.createError) {
        throw Object.assign(new Error(`status ${opts.createError.status}`), opts.createError);
      }
      calls.create.push(input);
      return { ghsaId: "GHSA-new", htmlUrl: url("GHSA-new") };
    },
    update: async (input) => {
      calls.update.push(input);
      return { ghsaId: input.ghsaId, htmlUrl: url(input.ghsaId) };
    },
  };
  return { deps, calls };
}

async function row(reportId: string) {
  const [r] = await dbm.db.select().from(dbm.ownerAdvisory).where(dbm.eq(dbm.ownerAdvisory.reportId, reportId));
  return r;
}

test("a request is refused unless the report is a delivered, reproduced email or GitHub report with a live repo", async () => {
  const cases: [Fixture, RegExp][] = [
    [{ channel: "manual" }, /only an email or GitHub report/],
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
  const { reportId, marker } = await seed();
  await advisory.requestOwnerAdvisory(reportId, "r");
  const { deps, calls } = fakeGitHub({ existing: marker });

  await advisory.adviseOnce({ deps });
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update.length, 0, "it already carries this revision");
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
  assert.match((await row(refused.reportId)).lastError ?? "", /has not granted "Repository security advisories: write"/);

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

test("a GitHub report's owner gets the advisory too, with severity and CWEs from its findings", async () => {
  const { reportId, payload } = await seed({ channel: "github" });
  assert.deepEqual(await advisory.requestOwnerAdvisory(reportId, "r"), { ok: true });
  const { deps, calls } = fakeGitHub();

  await advisory.adviseOnce({ deps });
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].description, payload);
  assert.equal(calls.create[0].severity, "high");
  assert.deepEqual(calls.create[0].cweIds, ["CWE-79", "CWE-89"]);
  assert.equal((await row(reportId)).state, "SENT");
});

/** A report whose advisory went out for revision 1, and a revision 2 since delivered. */
async function revised() {
  const first = await seed();
  await advisory.requestOwnerAdvisory(first.reportId, "r");
  await advisory.adviseOnce({ deps: fakeGitHub().deps });
  assert.equal((await row(first.reportId)).state, "SENT");
  const second = await addRevision(first.reportId, 2);
  return { reportId: first.reportId, first, second };
}

test("a later delivered revision updates the same advisory with its approved text, once", async () => {
  const { reportId, second } = await revised();

  assert.deepEqual(await advisory.requestOwnerAdvisory(reportId, "r"), { ok: true });
  const queued = await row(reportId);
  assert.equal(queued.state, "PENDING");
  assert.equal(queued.verdictId, second.verdictId);
  assert.equal(queued.ghsaId, "GHSA-new", "the advisory it updates is kept");
  assert.match(
    (await advisory.requestOwnerAdvisory(reportId, "r") as { reason: string }).reason,
    /already been notified/,
    "a double click while it is pending queues nothing",
  );

  const { deps, calls } = fakeGitHub();
  await advisory.adviseOnce({ deps });
  assert.equal(calls.create.length, 0);
  assert.equal(calls.markers.length, 0, "a known advisory needs no search");
  assert.deepEqual(
    calls.update.map((u) => [u.ghsaId, u.description]),
    [["GHSA-new", second.payload]],
  );
  const sent = await row(reportId);
  assert.equal(sent.state, "SENT");
  assert.equal(sent.ghsaId, "GHSA-new");
  assert.match(
    (await advisory.requestOwnerAdvisory(reportId, "r") as { reason: string }).reason,
    /already been notified/,
    "the advisory already carries the latest revision",
  );

  // A worker that died after the PATCH but before the row said SENT sends the same bytes to the
  // same advisory again: nothing new is opened.
  await dbm.db
    .update(dbm.ownerAdvisory)
    .set({ state: "PENDING", nextAttemptAt: new Date(0) })
    .where(dbm.eq(dbm.ownerAdvisory.reportId, reportId));
  const replay = fakeGitHub();
  await advisory.adviseOnce({ deps: replay.deps });
  assert.equal(replay.calls.create.length, 0);
  assert.deepEqual(replay.calls.update, calls.update);
  assert.equal((await row(reportId)).ghsaId, "GHSA-new");
});

test("an update whose revision no longer matches its approved hash is never sent", async () => {
  const { reportId } = await revised();
  await advisory.requestOwnerAdvisory(reportId, "r");
  const { deps, calls } = fakeGitHub();

  await advisory.adviseOnce({ deps: { ...deps, hashContent: () => "tampered" } });
  assert.equal(calls.mint, 0);
  assert.equal(calls.update.length, 0);
  const failed = await row(reportId);
  assert.equal(failed.state, "FAILED");
  assert.match(failed.lastError ?? "", /content hash mismatch/);
  assert.equal(failed.htmlUrl, "https://github.com/x/y/security/advisories/GHSA-new", "the advisory stays linked");
});

test("a revision that did not reproduce, or has not reached the reporter, cannot update the advisory", async () => {
  const notReproduced = await revised();
  await dbm.db.delete(dbm.outboundDelivery).where(dbm.eq(dbm.outboundDelivery.verdictId, notReproduced.second.verdictId));
  const third = await addRevision(notReproduced.reportId, 3, { outcome: "NOT_REPRODUCED" });
  assert.match(
    (await advisory.requestOwnerAdvisory(notReproduced.reportId, "r") as { reason: string }).reason,
    /only a reproduced verdict/,
  );
  assert.notEqual((await row(notReproduced.reportId)).verdictId, third.verdictId);

  const undelivered = await seed();
  await advisory.requestOwnerAdvisory(undelivered.reportId, "r");
  await advisory.adviseOnce({ deps: fakeGitHub().deps });
  await addRevision(undelivered.reportId, 2, { delivered: false });
  assert.match(
    (await advisory.requestOwnerAdvisory(undelivered.reportId, "r") as { reason: string }).reason,
    /already been notified/,
  );
});

test("an advisory a crashed revision-1 send left on GitHub is updated for revision 2, not twinned", async () => {
  const first = await seed();
  await advisory.requestOwnerAdvisory(first.reportId, "r");
  // The first send created the draft on GitHub, then exhausted its retries before recording it.
  await dbm.db
    .update(dbm.ownerAdvisory)
    .set({ state: "FAILED" })
    .where(dbm.eq(dbm.ownerAdvisory.reportId, first.reportId));
  const second = await addRevision(first.reportId, 2);
  assert.deepEqual(await advisory.requestOwnerAdvisory(first.reportId, "r"), { ok: true });

  const { deps, calls } = fakeGitHub({ existing: first.marker });
  await advisory.adviseOnce({ deps });
  assert.equal(calls.create.length, 0);
  assert.deepEqual(new Set(calls.markers[0]), new Set([first.marker, second.marker]));
  assert.deepEqual(
    calls.update.map((u) => [u.ghsaId, u.description]),
    [["GHSA-old", second.payload]],
  );
  assert.equal((await row(first.reportId)).ghsaId, "GHSA-old");
});

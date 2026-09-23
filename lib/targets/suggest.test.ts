import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * The body is reporter-controlled, so the parser is tested against lookalikes as much as against
 * real links, and the match is tested against every way a grant stops being live: a suggestion
 * the server would refuse to bind is worse than none.
 */

// Imported only after createSchema: ./suggest loads @/lib/db, and loading it first would point
// every fixture below at the real database instead of the disposable schema.
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let suggest: typeof import("./suggest");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("target_suggest");
  dbm = await import("@/lib/db");
  suggest = await import("./suggest");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

test("reads owner/repo from plain text and from an HTML href", () => {
  assert.deepEqual(
    suggest.repositoryMentions(
      'See https://github.com/Vaibhav91one/juice-shop/tree/v17.3.0/routes and <a href="https://www.github.com/acme/api">here</a>.',
    ),
    ["Vaibhav91one/juice-shop", "acme/api"],
  );
});

test("strips .git and trailing punctuation, and keeps the first spelling of a name", () => {
  assert.deepEqual(
    suggest.repositoryMentions(
      "clone github.com/Acme/Api.git, or github.com/acme/api. Also http://github.com/ACME/API/issues/3",
    ),
    ["Acme/Api"],
  );
});

test("ignores lookalike hosts, GitHub's own pages and malformed owners", () => {
  assert.deepEqual(
    suggest.repositoryMentions(
      [
        "https://notgithub.com/acme/api",
        "https://github.com.evil.io/acme/api",
        "https://evil.github.com/acme/api",
        "https://github.com/orgs/acme",
        "https://github.com/settings/apps",
        "https://github.com/-bad/repo",
        "https://github.com/acme",
      ].join("\n"),
    ),
    [],
  );
});

test("caps the number of names returned", () => {
  const body = Array.from({ length: 30 }, (_, i) => `github.com/o/r${i}`).join(" ");
  assert.equal(suggest.repositoryMentions(body).length, 10);
});

let seq = 0;

type Shape = "live" | "inactive" | "archived" | "suspended" | "deleted" | "no-target" | "retired";

async function seedRepo(shape: Shape) {
  seq += 1;
  const n = seq;
  const [profile] = await dbm.db
    .insert(dbm.targetProfile)
    .values({
      name: `suggest-${n}`,
      imageDigest: `sha256:suggest-${n}`,
      retiredAt: shape === "retired" ? new Date() : null,
    })
    .returning({ id: dbm.targetProfile.id, name: dbm.targetProfile.name });
  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({
      installationId: 800000 + n,
      accountLogin: `own-${n}`,
      accountId: 900000 + n,
      accountType: "User",
      suspendedAt: shape === "suspended" ? new Date() : null,
      deletedAt: shape === "deleted" ? new Date() : null,
    })
    .returning({ id: dbm.githubInstallation.id });
  const fullName = `Own-${n}/Repo-${n}`;
  await dbm.db.insert(dbm.connectedRepository).values({
    installationId: installation.id,
    repoId: 400000 + n,
    fullName,
    targetProfileId: shape === "no-target" ? null : profile.id,
    active: shape !== "inactive",
    archivedAt: shape === "archived" ? new Date() : null,
  });
  return { profile, fullName };
}

test("a live connected repository with a built target is suggested, matched case-insensitively", async () => {
  const { profile, fullName } = await seedRepo("live");
  const result = await suggest.suggestTargets(
    `Found on https://github.com/${fullName.toLowerCase()}/blob/main/x.js and github.com/nobody/here`,
  );
  assert.deepEqual(result.matched, [
    { profileId: profile.id, profileName: profile.name, fullName, mention: fullName.toLowerCase() },
  ]);
  assert.deepEqual(result.unconnected, ["nobody/here"]);
  // Something is unconnected, so the reviewer is told where to add it: the seeded installations.
  assert.ok(result.connectLinks.length > 0);
  assert.ok(result.connectLinks.every((link) => link.href.startsWith("https://github.com/")));
});

test("a repository whose grant or target is not usable is never suggested", async () => {
  for (const shape of ["inactive", "archived", "suspended", "deleted", "no-target", "retired"] as const) {
    const { fullName } = await seedRepo(shape);
    const result = await suggest.suggestTargets(`https://github.com/${fullName}`);
    assert.deepEqual(result.matched, [], shape);
    assert.deepEqual(result.unconnected, [fullName], shape);
  }
});

test("a body with no links costs no query and suggests nothing", async () => {
  assert.deepEqual(await suggest.suggestTargets("no links here"), {
    matched: [],
    unconnected: [],
    progress: [],
    connectLinks: [],
  });
});

let forkSeq = 0;

/**
 * A fork of `upstream`, connected under a live installation, at a given stage. `ready` gives it a
 * built target; any other stage leaves the target unset and records that onboarding state.
 */
async function seedFork(opts: {
  upstream: string;
  via?: "parent" | "source";
  stage: "ready" | "PENDING_BUILD" | "AWAITING_APPROVAL" | "FAILED" | "UNSUPPORTED" | "never";
  revoked?: boolean;
}) {
  forkSeq += 1;
  const n = 700 + forkSeq;
  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({ installationId: 810000 + n, accountLogin: `me-${n}`, accountId: 910000 + n, accountType: "User" })
    .returning({ id: dbm.githubInstallation.id });
  const profile =
    opts.stage === "ready"
      ? (
          await dbm.db
            .insert(dbm.targetProfile)
            .values({ name: `fork-${n}`, imageDigest: `sha256:fork-${n}` })
            .returning({ id: dbm.targetProfile.id, name: dbm.targetProfile.name })
        )[0]
      : null;
  const fullName = `Me-${n}/Fork-${n}`;
  const repoId = 410000 + n;
  await dbm.db.insert(dbm.connectedRepository).values({
    installationId: installation.id,
    repoId,
    fullName,
    targetProfileId: profile?.id ?? null,
    active: !opts.revoked,
    parentFullName: opts.via === "source" ? "Someone/Middle" : opts.upstream,
    sourceFullName: opts.upstream,
  });
  if (opts.stage !== "ready" && opts.stage !== "never") {
    await dbm.db.insert(dbm.targetOnboarding).values({
      repoId,
      repoFullName: fullName,
      sourceRef: `https://github.com/${fullName}.git`,
      state: opts.stage,
      lastError: opts.stage === "FAILED" ? "build timed out" : null,
      buildPlan: opts.stage === "UNSUPPORTED" ? { strategy: "not-flattenable", reason: "needs MongoDB" } : null,
    });
  }
  return { fullName, profile };
}

test("a connected fork stands in for the upstream the report links, by parent or by fork root", async () => {
  for (const via of ["parent", "source"] as const) {
    const upstream = `Upstream-${via}/NodeGoat`;
    const { fullName, profile } = await seedFork({ upstream, via, stage: "ready" });
    const result = await suggest.suggestTargets(`see https://github.com/${upstream}`);
    assert.deepEqual(
      result.matched,
      [{ profileId: profile!.id, profileName: profile!.name, fullName, mention: upstream }],
      via,
    );
    assert.deepEqual(result.progress, [{ name: upstream, status: "ready", repoFullName: fullName, reason: null }]);
    assert.deepEqual(result.unconnected, []);
  }
});

test("each onboarding stage of a connected fork is reported, with the reason when it stopped", async () => {
  const cases = [
    ["PENDING_BUILD", "onboarding", null],
    ["AWAITING_APPROVAL", "awaiting-approval", null],
    ["FAILED", "failed", "build timed out"],
    ["UNSUPPORTED", "unsupported", "needs MongoDB"],
  ] as const;
  for (const [stage, status, reason] of cases) {
    const upstream = `Stage-${stage.toLowerCase().replace("_", "-")}/app`;
    const { fullName } = await seedFork({ upstream, stage });
    const result = await suggest.suggestTargets(`https://github.com/${upstream}`);
    assert.deepEqual(result.matched, [], stage);
    assert.deepEqual(result.unconnected, [upstream], stage);
    assert.deepEqual(result.progress, [{ name: upstream, status, repoFullName: fullName, reason }], stage);
  }

  // Connected but never onboarded is what a private repository looks like.
  const { fullName } = await seedFork({ upstream: "Private-Up/app", stage: "never" });
  const [never] = (await suggest.suggestTargets("https://github.com/Private-Up/app")).progress;
  assert.equal(never.status, "unsupported");
  assert.equal(never.repoFullName, fullName);
  assert.match(never.reason ?? "", /private/);
});

test("a revoked fork is not connected, whatever target it once had", async () => {
  await seedFork({ upstream: "Revoked-Up/app", stage: "ready", revoked: true });
  const result = await suggest.suggestTargets("https://github.com/Revoked-Up/app");
  assert.deepEqual(result.matched, []);
  assert.deepEqual(result.progress, [
    { name: "Revoked-Up/app", status: "not-connected", repoFullName: null, reason: null },
  ]);
});

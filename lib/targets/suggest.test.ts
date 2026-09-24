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

type FakeRepo = { full_name: string; fork?: boolean; parent?: { full_name: string }; source?: { full_name: string } };

/**
 * GitHub's GET /repos/{owner}/{repo}, answered from a table. A name not in the table exists under
 * the name it was asked by and is no fork, so tests that are not about GitHub see literal matching.
 * `null` is a 404, and a number is that status.
 */
function github(table: Record<string, FakeRepo | null | number> = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const name = String(input).replace("https://api.github.com/repos/", "");
    calls.push(name);
    const entry = Object.entries(table).find(([key]) => key.toLowerCase() === name.toLowerCase());
    const answer = entry ? entry[1] : { full_name: name, fork: false };
    if (answer === null) return new Response('{"message":"Not Found"}', { status: 404 });
    if (typeof answer === "number") return new Response("{}", { status: answer, headers: { "retry-after": "120" } });
    return Response.json(answer);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const plain = github().fetchImpl;

function progressOf(
  p: Partial<import("./suggest").MentionProgress> & { name: string },
): import("./suggest").MentionProgress {
  return {
    canonical: null,
    status: "not-connected",
    repoFullName: null,
    via: null,
    reason: null,
    retrying: null,
    forkedAs: null,
    ...p,
  };
}

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
    { fetchImpl: plain },
  );
  assert.deepEqual(result.matched, [
    {
      profileId: profile.id,
      profileName: profile.name,
      fullName,
      mention: fullName.toLowerCase(),
      canonical: null,
      via: "link",
    },
  ]);
  assert.deepEqual(result.unconnected, ["nobody/here"]);
  // Something is unconnected, so the reviewer is told where to add it: the seeded installations.
  assert.ok(result.connectLinks.length > 0);
  assert.ok(result.connectLinks.every((link) => link.href.startsWith("https://github.com/")));
});

test("a repository whose grant or target is not usable is never suggested", async () => {
  for (const shape of ["inactive", "archived", "suspended", "deleted", "no-target", "retired"] as const) {
    const { fullName } = await seedRepo(shape);
    const result = await suggest.suggestTargets(`https://github.com/${fullName}`, { fetchImpl: plain });
    assert.deepEqual(result.matched, [], shape);
    assert.deepEqual(result.unconnected, [fullName], shape);
  }
});

test("a body with no links costs no query and suggests nothing", async () => {
  assert.deepEqual(await suggest.suggestTargets("no links here", { fetchImpl: plain }), {
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
  lastError?: string;
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
      lastError: opts.stage === "FAILED" ? "build timed out" : (opts.lastError ?? null),
      buildPlan: opts.stage === "UNSUPPORTED" ? { strategy: "not-flattenable", reason: "needs MongoDB" } : null,
    });
  }
  return { fullName, profile };
}

test("a connected fork stands in for the upstream the report links, by parent or by fork root", async () => {
  for (const via of ["parent", "source"] as const) {
    const upstream = `Upstream-${via}/NodeGoat`;
    const { fullName, profile } = await seedFork({ upstream, via, stage: "ready" });
    const result = await suggest.suggestTargets(`see https://github.com/${upstream}`, { fetchImpl: plain });
    assert.deepEqual(
      result.matched,
      [{ profileId: profile!.id, profileName: profile!.name, fullName, mention: upstream, canonical: null, via: "fork" }],
      via,
    );
    assert.deepEqual(result.progress, [progressOf({ name: upstream, status: "ready", repoFullName: fullName, via: "fork" })]);
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
    const result = await suggest.suggestTargets(`https://github.com/${upstream}`, { fetchImpl: plain });
    assert.deepEqual(result.matched, [], stage);
    assert.deepEqual(result.unconnected, [upstream], stage);
    assert.deepEqual(
      result.progress,
      [progressOf({ name: upstream, status, repoFullName: fullName, via: "fork", reason })],
      stage,
    );
  }

  // Connected but never onboarded is what a private repository looks like.
  const { fullName } = await seedFork({ upstream: "Private-Up/app", stage: "never" });
  const [never] = (await suggest.suggestTargets("https://github.com/Private-Up/app", { fetchImpl: plain })).progress;
  assert.equal(never.status, "unsupported");
  assert.equal(never.repoFullName, fullName);
  assert.match(never.reason ?? "", /private/);
});

test("a revoked fork is not connected, whatever target it once had", async () => {
  await seedFork({ upstream: "Revoked-Up/app", stage: "ready", revoked: true });
  const result = await suggest.suggestTargets("https://github.com/Revoked-Up/app", { fetchImpl: plain });
  assert.deepEqual(result.matched, []);
  assert.deepEqual(result.progress, [progressOf({ name: "Revoked-Up/app" })]);
});

test("a build that failed and will retry says so, and provider errors read as their message", async () => {
  const { fullName } = await seedFork({
    upstream: "Retry-Up/app",
    stage: "PENDING_BUILD",
    lastError: 'POST /sandbox -> 400 {"statusCode":400,"message":"Network access is restricted and cannot be overridden at the sandbox level."}',
  });
  const [progress] = (await suggest.suggestTargets("https://github.com/Retry-Up/app", { fetchImpl: plain })).progress;
  assert.equal(progress.status, "onboarding");
  assert.equal(progress.repoFullName, fullName);
  assert.equal(progress.retrying, "Network access is restricted and cannot be overridden at the sandbox level.");
});

test("readable onboarding errors are capped and fall back to the raw text", () => {
  assert.equal(suggest.readableOnboardingError(null), null);
  assert.equal(suggest.readableOnboardingError("build timed out\n  at step"), "build timed out at step");
  const long = suggest.readableOnboardingError("x".repeat(500));
  assert.equal(long?.length, 240);
  assert.ok(long?.endsWith("…"));
});

test("the lookup cache is deny-by-default like every other table", async () => {
  const [row] = await schema.admin<{ relrowsecurity: boolean }[]>`
    select relrowsecurity from pg_class
    where relnamespace = ${schema.name}::regnamespace and relname = 'github_repository_lookup'
  `;
  assert.equal(row?.relrowsecurity, true);
});

const unreachable = (async () => {
  throw new TypeError("fetch failed");
}) as typeof fetch;

test("a renamed upstream follows GitHub's redirect to its connected fork, and is asked about once", async () => {
  const { fullName, profile } = await seedFork({ upstream: "New-Org/renamed-app", stage: "ready" });
  const gh = github({ "Old-Owner/renamed-app": { full_name: "New-Org/renamed-app", fork: false } });

  const result = await suggest.suggestTargets("see https://github.com/Old-Owner/renamed-app", { fetchImpl: gh.fetchImpl });
  assert.deepEqual(result.matched, [
    {
      profileId: profile!.id,
      profileName: profile!.name,
      fullName,
      mention: "Old-Owner/renamed-app",
      canonical: "New-Org/renamed-app",
      via: "fork",
    },
  ]);
  assert.deepEqual(gh.calls, ["old-owner/renamed-app"]);

  // Every later poll reads the stored answer, which is what keeps the 5 second poll off GitHub.
  const later = github();
  const again = await suggest.suggestTargets("https://github.com/old-owner/Renamed-App", { fetchImpl: later.fetchImpl });
  assert.deepEqual(later.calls, []);
  assert.equal(again.matched[0]?.profileId, profile!.id);
  assert.equal(again.matched[0]?.canonical, "New-Org/renamed-app");
});

test("a link GitHub no longer has matches on repository name, but only within one project", async () => {
  // bkimminich/juice-shop is the real case: the repository moved and its old name now 404s.
  const { fullName, profile } = await seedFork({ upstream: "Shop-Org/shop-x", stage: "ready" });
  const gone = github({ "Gone-Owner/shop-x": null });
  const result = await suggest.suggestTargets("https://github.com/Gone-Owner/shop-x", { fetchImpl: gone.fetchImpl });
  assert.deepEqual(result.matched, [
    { profileId: profile!.id, profileName: profile!.name, fullName, mention: "Gone-Owner/shop-x", canonical: null, via: "name" },
  ]);

  // Two unrelated projects that share a name: a guess between them would be a coin toss.
  await seedFork({ upstream: "Alpha-Org/common-api", stage: "ready" });
  await seedFork({ upstream: "Beta-Org/common-api", stage: "ready" });
  const ambiguous = await suggest.suggestTargets("https://github.com/Nobody-Here/common-api", {
    fetchImpl: github({ "Nobody-Here/common-api": null }).fetchImpl,
  });
  assert.deepEqual(ambiguous.matched, []);
  assert.deepEqual(ambiguous.unconnected, ["Nobody-Here/common-api"]);

  // A link GitHub does have is never matched on name alone.
  const real = await suggest.suggestTargets("https://github.com/Someone-Else/shop-x", { fetchImpl: plain });
  assert.deepEqual(real.matched, []);
});

test("a GitHub failure keeps the last answer and backs off instead of retrying every poll", async () => {
  const { lookupRepositories } = await import("./repository-lookup");
  const found = github({ "Cache-Owner/app": { full_name: "Cache-Owner/app" } });
  await lookupRepositories(["Cache-Owner/app"], { missingSeconds: 60, fetchImpl: found.fetchImpl });

  // Expire it; the refresh is rate limited, so the found answer stays and the next try waits.
  await dbm.db.execute(
    dbm.sql`update github_repository_lookup set expires_at = now() - interval '1 second' where name = 'cache-owner/app'`,
  );
  const limited = github({ "Cache-Owner/app": 429 });
  const after429 = await lookupRepositories(["Cache-Owner/app"], { missingSeconds: 60, fetchImpl: limited.fetchImpl });
  assert.deepEqual(limited.calls, ["cache-owner/app"]);
  assert.equal(after429.get("cache-owner/app")?.state, "found");
  assert.equal(after429.get("cache-owner/app")?.fullName, "Cache-Owner/app");
  const waiting = github();
  await lookupRepositories(["Cache-Owner/app"], { missingSeconds: 60, fetchImpl: waiting.fetchImpl });
  assert.deepEqual(waiting.calls, []);

  // A name first seen during an outage is recorded as an error, and matching falls back to the link.
  const down = await lookupRepositories(["Down-Owner/app"], { missingSeconds: 60, fetchImpl: unreachable });
  assert.equal(down.get("down-owner/app")?.state, "error");
});

test("concurrent polls fetch a new name once, and malformed names are never sent", async () => {
  const { lookupRepositories } = await import("./repository-lookup");
  const gh = github();
  await Promise.all([
    lookupRepositories(["Race-Owner/app"], { missingSeconds: 60, fetchImpl: gh.fetchImpl }),
    lookupRepositories(["race-owner/APP"], { missingSeconds: 60, fetchImpl: gh.fetchImpl }),
  ]);
  assert.deepEqual(gh.calls, ["race-owner/app"]);

  const bad = github();
  const none = await lookupRepositories(["../etc", "a/..", "x/y/z", "evil.com/repo"], {
    missingSeconds: 60,
    fetchImpl: bad.fetchImpl,
  });
  assert.equal(none.size, 0);
  assert.deepEqual(bad.calls, []);
});

async function seedInstallation(login: string) {
  forkSeq += 1;
  const n = 700 + forkSeq;
  await dbm.db
    .insert(dbm.githubInstallation)
    .values({ installationId: 810000 + n, accountLogin: login, accountId: 910000 + n, accountType: "User" });
}

test("a fork under an installed account is found before it is connected, only for the guided link", async () => {
  await seedInstallation("Fork-Owner");
  const gh = github({
    "Fork-Owner/tool": { full_name: "Fork-Owner/tool", fork: true, parent: { full_name: "Up-Fork/tool" }, source: { full_name: "Up-Fork/tool" } },
    "Fork-Owner/other": { full_name: "Fork-Owner/other", fork: true, parent: { full_name: "Up-Fork/other" } },
  });
  const body = "https://github.com/Up-Fork/tool and https://github.com/Up-Fork/other and https://github.com/Up-Fork/third";

  // No guide open: nothing is looked up beyond the links themselves.
  const unguided = await suggest.suggestTargets(body, { fetchImpl: gh.fetchImpl });
  assert.deepEqual(unguided.unconnected, ["Up-Fork/tool", "Up-Fork/other", "Up-Fork/third"]);
  assert.ok(unguided.progress.every((p) => p.forkedAs === null));
  assert.ok(!gh.calls.some((name) => name.startsWith("fork-owner/")));

  // The reviewer picks the second link, so only it is checked, and case does not matter.
  const guided = await suggest.suggestTargets(body, { guide: "up-fork/OTHER", fetchImpl: gh.fetchImpl });
  assert.deepEqual(
    guided.progress.map((p) => [p.name, p.forkedAs]),
    [
      ["Up-Fork/tool", null],
      ["Up-Fork/other", "Fork-Owner/other"],
      ["Up-Fork/third", null],
    ],
  );
  assert.ok(!gh.calls.includes("fork-owner/tool"));

  // A guide value that is not one of the report's links is ignored.
  const calls = gh.calls.length;
  const stray = await suggest.suggestTargets(body, { guide: "Fork-Owner/elsewhere", fetchImpl: gh.fetchImpl });
  assert.ok(stray.progress.every((p) => p.forkedAs === null));
  assert.equal(gh.calls.length, calls);
});

test("a same-named repository that is not a fork of the link does not tick the fork step", async () => {
  await seedInstallation("Lookalike-Owner");
  const gh = github({
    "Lookalike-Owner/widget": { full_name: "Lookalike-Owner/widget", fork: true, parent: { full_name: "Someone/widget" } },
  });
  const result = await suggest.suggestTargets("https://github.com/Real-Up/widget", {
    guide: "Real-Up/widget",
    fetchImpl: gh.fetchImpl,
  });
  assert.equal(result.progress[0].forkedAs, null);
  assert.ok(gh.calls.includes("lookalike-owner/widget"));
});

test("a link already under an installed account needs no fork, and a renamed link is forked by its new name", async () => {
  await seedInstallation("Home-Owner");
  const own = github();
  const home = await suggest.suggestTargets("https://github.com/Home-Owner/app", { guide: "Home-Owner/app", fetchImpl: own.fetchImpl });
  assert.equal(home.progress[0].forkedAs, "Home-Owner/app");
  assert.deepEqual(own.calls, ["home-owner/app"]);

  await seedInstallation("Renamed-Forker");
  const gh = github({
    "Was-Named/lib": { full_name: "Is-Named/lib" },
    "Renamed-Forker/lib": { full_name: "Renamed-Forker/lib", fork: true, parent: { full_name: "Is-Named/lib" } },
  });
  const renamed = await suggest.suggestTargets("https://github.com/Was-Named/lib", { guide: "Was-Named/lib", fetchImpl: gh.fetchImpl });
  assert.deepEqual(renamed.progress, [progressOf({ name: "Was-Named/lib", canonical: "Is-Named/lib", forkedAs: "Renamed-Forker/lib" })]);
});

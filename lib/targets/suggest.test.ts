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
  assert.deepEqual(result.matched, [{ profileId: profile.id, profileName: profile.name, fullName }]);
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
    connectLinks: [],
  });
});

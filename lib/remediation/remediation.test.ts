import assert from "node:assert/strict";
import test, { after, before, mock } from "node:test";

/**
 * Real Postgres in a disposable schema for the record and route tests. @/lib/db and everything
 * that imports it load dynamically after createSchema, otherwise the pool would point at prod.
 * Storage is cleared so rows are written with a null storage_path, as in record.test.ts.
 */
let session: { login: string } | null = null;
mock.module("@/lib/auth/dal", { namedExports: { currentSession: async () => session } });

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let record: typeof import("@/lib/artifacts/record");
let route: typeof import("@/app/api/reports/[id]/remediation-patch/route");
const storageEnv = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

const GOOD = [
  "--- a/src/login.ts",
  "+++ b/src/login.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const q = `select * from u where n = '${n}'`;",
  "+const q = db.prepare('select * from u where n = ?');",
  " export {};",
  "",
].join("\n");

before(async () => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("remediation_patch");
  dbm = await import("@/lib/db");
  record = await import("@/lib/artifacts/record");
  route = await import("@/app/api/reports/[id]/remediation-patch/route");
  await dbm.db.execute("select 1");
});

after(async () => {
  if (storageEnv.url !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = storageEnv.url;
  if (storageEnv.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = storageEnv.key;
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

test("isValidUnifiedDiff accepts a well-formed diff", async () => {
  const { isValidUnifiedDiff } = await import("./patch");
  assert.equal(isValidUnifiedDiff(GOOD), true);
  assert.equal(isValidUnifiedDiff(`${GOOD}\n\n`), true, "trailing blank lines are fine");
  assert.equal(isValidUnifiedDiff(`diff --git a/x b/x\nindex 1..2 100644\n${GOOD}`), true);
});

test("isValidUnifiedDiff rejects prose, truncated hunks, bad paths and oversized input", async () => {
  const { isValidUnifiedDiff } = await import("./patch");
  const { MAX_PATCH_CHARS } = await import("@/lib/mcp/verdict-draft");
  assert.equal(isValidUnifiedDiff("Use a prepared statement instead."), false);
  assert.equal(isValidUnifiedDiff(""), false);
  assert.equal(isValidUnifiedDiff("--- a/x\n+++ b/x\n"), false, "headers without a hunk");
  // Hunk header promises 3 lines each side but the body stops short.
  assert.equal(isValidUnifiedDiff("--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n"), false);
  assert.equal(isValidUnifiedDiff(GOOD.replace(/src\/login\.ts/g, "../../etc/passwd")), false);
  assert.equal(isValidUnifiedDiff(GOOD.replace(/src\/login\.ts/g, "/etc/passwd")), false);
  const hdr = (line: string) => `${line}\n${GOOD}`;
  assert.equal(isValidUnifiedDiff(hdr("rename to ../x")), false);
  assert.equal(isValidUnifiedDiff(hdr("copy from /etc/passwd")), false);
  assert.equal(isValidUnifiedDiff(hdr("diff --git a/x b/../y")), false);
  assert.equal(isValidUnifiedDiff(hdr("diff --git a/x b/y")), true);
  assert.equal(isValidUnifiedDiff(`${GOOD}trailing prose\n`), false);
  assert.equal(isValidUnifiedDiff(`${GOOD}${"+x\n".repeat(MAX_PATCH_CHARS)}`), false);
});

test("buildRemediationPatch drops patches past the aggregate cap", async () => {
  const { buildRemediationPatch, MAX_TOTAL_PATCH_CHARS } = await import("./patch");
  const body = Array.from({ length: 1000 }, (_, k) => `+line ${k}`);
  const big = `--- a/f\n+++ b/f\n@@ -0,0 +1,${body.length} @@\n${body.join("\n")}\n`;
  const finding = (n: number) => ({ title: `f${n}`, severity: "low" as const, description: "d", evidenceRef: "e", remediationPatch: big });
  const count = Math.ceil(MAX_TOTAL_PATCH_CHARS / big.length) + 3;
  const out = buildRemediationPatch(Array.from({ length: count }, (_, n) => finding(n)))!;
  assert.ok(out.length <= MAX_TOTAL_PATCH_CHARS);
  assert.ok(out.includes("# Finding 1:") && !out.includes(`# Finding ${count}:`));
});

let seq = 0;
async function seedVerdict(outcome: "REPRODUCED" | "ANALYSIS_ONLY", opts: { target: boolean; patch?: string }) {
  seq += 1;
  let targetProfileId: string | undefined;
  if (opts.target) {
    const [t] = await dbm.db
      .insert(dbm.targetProfile)
      .values({ name: `t-${seq}`, imageName: `ghcr.io/acme/t${seq}`, imageDigest: `sha256:${"a".repeat(64)}` })
      .returning({ id: dbm.targetProfile.id });
    targetProfileId = t.id;
  }
  const [r] = await dbm.db
    .insert(dbm.report)
    .values({ channel: "github", sourceRef: `github:7:issue:${seq}`, title: `r${seq}`, body: "b", ...(targetProfileId ? { targetProfileId } : {}) })
    .returning({ id: dbm.report.id });
  const finding = {
    title: "SQL injection in login",
    severity: "high",
    description: "d",
    evidenceRef: "e",
    ...(opts.patch ? { remediationPatch: opts.patch } : {}),
  };
  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: r.id,
      outcome,
      summary: "s",
      payload: `payload ${seq}`,
      contentHash: `hash-${seq}`,
      evidence: { source: "agent-drafted", findings: [finding] },
    })
    .returning({ id: dbm.verdict.id });
  return { reportId: r.id, verdictId: v.id };
}

async function patchRows(reportId: string) {
  const rows = await dbm.db.select().from(dbm.artifact).where(dbm.eq(dbm.artifact.reportId, reportId));
  return rows.filter((row) => row.kind === "remediation-patch");
}

test("a REPRODUCED verdict on a bound target records the patch artifact as text/x-diff", async () => {
  const { reportId, verdictId } = await seedVerdict("REPRODUCED", { target: true, patch: GOOD });
  await record.recordVerdictArtifacts(reportId, verdictId);
  const rows = await patchRows(reportId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contentType, "text/x-diff");
});

test("nothing is recorded without a bound target, off REPRODUCED, or for an invalid patch", async () => {
  for (const [outcome, target, patch] of [
    ["REPRODUCED", false, GOOD],
    ["ANALYSIS_ONLY", true, GOOD],
    ["REPRODUCED", true, "just prose, not a diff"],
    ["REPRODUCED", true, undefined],
  ] as const) {
    const { reportId, verdictId } = await seedVerdict(outcome, { target, patch });
    await record.recordVerdictArtifacts(reportId, verdictId);
    assert.equal((await patchRows(reportId)).length, 0, `${outcome} target=${target}`);
  }
});

test("the route refuses an anonymous caller and serves the diff as an attachment to a reviewer", async () => {
  const { reportId, verdictId } = await seedVerdict("REPRODUCED", { target: true, patch: GOOD });
  await record.recordVerdictArtifacts(reportId, verdictId);
  const call = () => route.GET(new Request("http://x"), { params: Promise.resolve({ id: reportId }) });

  session = null;
  assert.equal((await call()).status, 401);

  session = { login: "reviewer" };
  const ok = await call();
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type") ?? "", /^text\/x-diff/);
  assert.match(ok.headers.get("content-disposition") ?? "", /^attachment; filename=".+\.diff"$/);
  assert.match(await ok.text(), /\+const q = db\.prepare/);

  // A later revision without a patch supersedes the older one, whose patch must stop being served.
  await dbm.db.insert(dbm.verdict).values({
    reportId,
    outcome: "ANALYSIS_ONLY",
    summary: "s2",
    payload: "p2",
    contentHash: `hash-rev2-${reportId}`,
    revision: 2,
  });
  assert.equal((await call()).status, 404);

  const none = await seedVerdict("ANALYSIS_ONLY", { target: true });
  const missing = await route.GET(new Request("http://x"), { params: Promise.resolve({ id: none.reportId }) });
  assert.equal(missing.status, 404);
});

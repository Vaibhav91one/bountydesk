import assert from "node:assert/strict";
import test, { after, before, mock } from "node:test";

/**
 * open_build_sandbox for each source kind, with a fake sandbox. Daytona is the only seam faked: the
 * real build tool resolves the capability, loads the upload's stored material, picks the egress
 * hosts and stages the source, so what is proven here is which commands run and which hosts are
 * opened for a GitHub row, an archive upload and a git upload.
 */
type Call = { hosts: string[] };
const created: Call[] = [];
const commands: string[] = [];
const deleted: string[] = [];
let revParse = "";

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let build: typeof import("./build");
let intake: typeof import("@/lib/upload/intake");

const CONFIG = { perSenderPerDay: 50, perDomainPerDay: 50, maxBytes: 512 * 1024, exemptDomains: [] };
const SHA = "ab12cd".repeat(6) + "abcd";

before(async () => {
  // The mocks go in before ./build is imported, and keep the real exports the driver module also needs.
  process.env.BUILD_BASE_SNAPSHOT = "base-snapshot";
  const realDaytona = await import("@/lib/sandbox/daytona");
  const realAccess = await import("@/lib/github/repo-access");
  mock.module("@/lib/sandbox/daytona", {
    namedExports: {
      ...realDaytona,
      createBuildSandbox: async (_spec: unknown, hosts: string[]) => {
        created.push({ hosts });
        return { id: `sbx-${created.length}`, toolboxProxyUrl: "http://toolbox.test" };
      },
      getSandbox: async () => {
        throw new Error("no open sandbox");
      },
      deleteSandbox: async (id: string) => void deleted.push(id),
      execute: async (_sandbox: unknown, command: string) => {
        // The tool wraps each command in sh -lc '...', which escapes inner single quotes.
        commands.push(command.split("'\\''").join("'"));
        return { exitCode: 0, result: command.includes("rev-parse HEAD") ? revParse : "" };
      },
    },
  });
  mock.module("@/lib/github/repo-access", {
    namedExports: { ...realAccess, repoReadToken: async () => null },
  });
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("mcp_build_upload");
  dbm = await import("@/lib/db");
  build = await import("./build");
  intake = await import("@/lib/upload/intake");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;
async function uploadOnboarding(fields: Record<string, string | Blob>, token: string): Promise<string> {
  seq += 1;
  const data = new FormData();
  for (const [k, v] of Object.entries({ title: `t${seq}`, body: "b", contact: `c${seq}@outside.test`, ...fields })) {
    data.set(k, v);
  }
  const parsed = await intake.parseUploadForm(data, CONFIG);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  const admitted = await intake.admitUpload(parsed.submission, null, { sendCode: async () => {}, config: CONFIG });
  assert.ok(admitted.accepted);
  const [upload] = await dbm.db.select().from(dbm.uploadIntake).where(dbm.eq(dbm.uploadIntake.reportId, admitted.reportId));
  const [row] = await dbm.db
    .insert(dbm.targetOnboarding)
    .values({
      uploadId: upload.id,
      repoId: -seq,
      repoFullName: `upload/u${seq}`,
      sourceRef: "upload:x",
      state: "UPLOAD_AGENT",
      agentCapabilityToken: token,
    })
    .returning({ id: dbm.targetOnboarding.id });
  return row.id;
}

function reset(): void {
  created.length = 0;
  commands.length = 0;
  deleted.length = 0;
  revParse = SHA;
}

test("an archive upload stages its stored bytes and opens no clone host", async () => {
  reset();
  const id = await uploadOnboarding({ dockerfile: new Blob(["FROM nginx\n"]) }, "tok-archive");
  const result = await build.openBuildSandbox("tok-archive");
  assert.equal(result.ok, true);
  assert.ok(commands.some((c) => c.includes("base64 -d > /work/source.tgz")));
  assert.ok(commands.some((c) => c.includes("tar -xf /work/source.tgz -C /work/source")));
  assert.ok(!commands.some((c) => c.includes("git clone")));
  assert.ok(!created[0].hosts.includes("gitlab.com"));
  const [row] = await dbm.db.select().from(dbm.targetOnboarding).where(dbm.eq(dbm.targetOnboarding.id, id));
  assert.equal(row.agentSandboxId, "sbx-1");
});

test("a git upload clones its validated URL at the pinned commit with only that host added", async () => {
  reset();
  await uploadOnboarding({ gitUrl: "https://gitlab.com/group/app", gitCommit: SHA }, "tok-git");
  const result = await build.openBuildSandbox("tok-git");
  assert.equal(result.ok, true);
  assert.ok(created[0].hosts.includes("gitlab.com"));
  assert.ok(commands.some((c) => c.includes("clone --no-checkout 'https://gitlab.com/group/app'")));
  assert.ok(commands.some((c) => c.includes(`git checkout --detach '${SHA}'`)));
  assert.ok(!commands.some((c) => c.includes("github.com")));
});

test("a git upload whose clone resolves to another commit is torn down and refused", async () => {
  reset();
  revParse = "f".repeat(40);
  const id = await uploadOnboarding({ gitUrl: "https://gitlab.com/group/other", gitCommit: SHA }, "tok-git-bad");
  const result = await build.openBuildSandbox("tok-git-bad");
  assert.equal(result.ok, false);
  assert.deepEqual(deleted, ["sbx-1"]);
  const [row] = await dbm.db.select().from(dbm.targetOnboarding).where(dbm.eq(dbm.targetOnboarding.id, id));
  assert.equal(row.agentSandboxId, null);
});

test("a GitHub onboarding still clones the connected repository", async () => {
  reset();
  await dbm.db.insert(dbm.targetOnboarding).values({
    repoId: 990_001,
    repoFullName: "acme/tool",
    sourceRef: "https://github.com/acme/tool.git",
    resolvedCommitSha: SHA,
    agentCapabilityToken: "tok-github",
  });
  const result = await build.openBuildSandbox("tok-github");
  assert.equal(result.ok, true);
  assert.ok(commands.some((c) => c.includes("clone --no-checkout 'https://github.com/acme/tool.git'")));
  assert.ok(!created[0].hosts.includes("gitlab.com"));
});

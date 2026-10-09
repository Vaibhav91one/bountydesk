import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import test, { after, before } from "node:test";

import type { BuildDriver, BuildInput, BuildResult } from "@/lib/build-onboarding/build-driver";

/**
 * A multi-file source tarball through the upload build path, against a real Postgres. The existing
 * build.test.ts covers an image and a single Dockerfile wrapped into a one-file tar; this covers the
 * archive material kind proper: a real .tar.gz that carries a root Dockerfile alongside other files,
 * so the build source is `archive` and the target is anchored on the sourceArchiveDigest. The build
 * driver is faked (it is the one seam that needs Daytona), everything after it is production code.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let intake: typeof import("./intake");
let gate: typeof import("./gate");
let build: typeof import("./build");
let worker: typeof import("@/lib/jobs/worker");

const CONFIG = { perSenderPerDay: 50, perDomainPerDay: 50, maxBytes: 512 * 1024, exemptDomains: [] };
const TARGET = { port: 8080, readinessPath: "/health" };

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("upload_build_archive");
  dbm = await import("@/lib/db");
  intake = await import("./intake");
  gate = await import("./gate");
  build = await import("./build");
  worker = await import("@/lib/jobs/worker");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

/** A ustar header for one file, mtime/uid/gid fixed at zero so the same inputs hash the same way. */
function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, "latin1");
  header.write("0000000\0", 108, "latin1");
  header.write("0000000\0", 116, "latin1");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  header.write("00000000000\0", 136, "latin1");
  header.write("        ", 148, "latin1");
  header.write("0", 156, "latin1");
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return header;
}

/** A whole uncompressed ustar tar holding several files at the archive root. */
function tar(files: Array<{ name: string; content: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, content } of files) {
    const body = Buffer.from(content, "utf8");
    blocks.push(tarHeader(name, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  // Two zero blocks mark the end of the archive.
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** The bytes are stable, so the gzip and the sha256 the intake records are stable too. */
function tarGz(files: Array<{ name: string; content: string }>): Buffer {
  return gzipSync(tar(files), { level: 9 });
}

let n = 0;
async function heldArchiveUpload(archive: Buffer): Promise<string> {
  n += 1;
  const data = new FormData();
  data.set("title", `archive upload ${n}`);
  data.set("body", "report body");
  data.set("contact", `archive${n}@outside.test`);
  data.set("archive", new Blob([Uint8Array.from(archive)]));
  const parsed = await intake.parseUploadForm(data, CONFIG);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  assert.equal(parsed.submission.material?.kind, "archive");
  const admitted = await intake.admitUpload(parsed.submission, null, { sendCode: async () => {}, config: CONFIG });
  assert.ok(admitted.accepted);
  return admitted.reportId;
}

function fakeDriver(outcome: "ok" | "fail" = "ok"): BuildDriver & { calls: BuildInput[] } {
  const calls: BuildInput[] = [];
  return {
    calls,
    async build(input): Promise<BuildResult> {
      calls.push(input);
      // A tarball with no Dockerfile at its root fails the real `docker build`; the fake stands in for
      // that build-time failure, which is what routes the report to the static fallback.
      if (outcome === "fail") throw new Error("docker build exited 1");
      const source = input.source!;
      assert.equal(source.kind, "archive");
      const sourceArchiveDigest = source.kind === "archive" ? source.sourceArchiveDigest : "";
      return {
        imageName: `ghcr.io/ns/${input.repoFullName.replace("/", "-")}`,
        imageDigest: `sha256:${"d".repeat(64)}`,
        snapshotId: `snap-${n}`,
        dockerfileText: "FROM scratch\n",
        buildLog: "built",
        buildMarker: sourceArchiveDigest,
        buildRecipeDigest: `sha256:${"e".repeat(64)}`,
        sourceArchiveDigest,
      };
    },
  };
}

async function reportRow(id: string) {
  const [row] = await dbm.db.select().from(dbm.report).where(dbm.eq(dbm.report.id, id));
  return row;
}

async function uploadRow(reportId: string) {
  const [row] = await dbm.db.select().from(dbm.uploadIntake).where(dbm.eq(dbm.uploadIntake.reportId, reportId));
  return row;
}

async function analysisJob(reportId: string) {
  const [row] = await dbm.db
    .select()
    .from(dbm.inboundJob)
    .where(dbm.eq(dbm.inboundJob.deliveryId, `gate-analysis:${reportId}`));
  return row;
}

test("a multi-file source tarball builds from the archive path and binds on its source archive digest", async () => {
  const archive = tarGz([
    { name: "Dockerfile", content: "FROM nginx:1.27\nCOPY index.html /usr/share/nginx/html/\n" },
    { name: "index.html", content: "<h1>hello</h1>\n" },
    { name: "README.md", content: "a test app\n" },
  ]);
  const expectedDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;

  const reportId = await heldArchiveUpload(archive);
  const upload = await uploadRow(reportId);
  assert.equal(upload.materialKind, "archive");
  assert.equal(upload.sourceArchiveDigest, expectedDigest);

  assert.deepEqual(await gate.approveUploadTarget(reportId, "reviewer", TARGET), { ok: true });
  const driver = fakeDriver();
  assert.ok(await build.buildUploadOnce({ driver }));

  // The driver was handed the archive material, not a wrapped Dockerfile.
  assert.equal(driver.calls.length, 1);
  const source = driver.calls[0].source;
  assert.ok(source?.kind === "archive");
  assert.equal(source.sourceArchiveDigest, expectedDigest);
  // The bytes survive the bytea round trip, so the driver can re-hash them in the sandbox.
  assert.equal(`sha256:${createHash("sha256").update(source.archive).digest("hex")}`, expectedDigest);
  assert.equal(driver.calls[0].plan.strategy, "dockerfile");

  const row = await reportRow(reportId);
  assert.ok(row.targetProfileId);
  assert.equal(row.connectedRepositoryId, null);
  const [profile] = await dbm.db
    .select()
    .from(dbm.targetProfile)
    .where(dbm.eq(dbm.targetProfile.id, row.targetProfileId!));
  assert.equal(profile.name, gate.uploadTargetName(reportId));
  // The archive digest, not a commit or an image digest, is the pinned anchor.
  assert.equal(profile.sourceArchiveDigest, expectedDigest);
  assert.equal(profile.resolvedCommitSha, null);

  assert.equal((await uploadRow(reportId)).buildState, "BUILT");
  assert.ok(await analysisJob(reportId));

  // Drain this report's queued run so the next test's worker call claims its own job, not this one
  // (claim() is global-FIFO). The bound target means this run can reproduce.
  let ran = "";
  await worker.runOnce("upload-archive-built-test", {
    analysis: { ensureSession: async () => {}, run: async ({ reportId: id }) => void (ran = id) },
  });
  assert.equal(ran, reportId);
});


test("a Dockerfile-less node tarball builds from a server-authored recipe pinned on the archive digest", async () => {
  const archive = tarGz([
    { name: "package.json", content: '{"name":"app","scripts":{"start":"node server.js"}}\n' },
    { name: "server.js", content: "require('http').createServer((q, r) => r.end('ok')).listen(8080)\n" },
  ]);
  const expectedDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  const reportId = await heldArchiveUpload(archive);
  await gate.approveUploadTarget(reportId, "reviewer", TARGET);

  const driver = fakeDriver();
  assert.ok(await build.buildUploadOnce({ driver }));
  assert.equal(driver.calls.length, 1);
  const { plan, source } = driver.calls[0];
  assert.ok(plan.strategy === "agent-authored" && plan.dockerfileText.startsWith("FROM node:"));
  assert.ok(source?.kind === "archive" && source.sourceArchiveDigest === expectedDigest);

  assert.equal((await uploadRow(reportId)).buildState, "BUILT");
  const [profile] = await dbm.db
    .select()
    .from(dbm.targetProfile)
    .where(dbm.eq(dbm.targetProfile.id, (await reportRow(reportId)).targetProfileId!));
  assert.equal(profile.sourceArchiveDigest, expectedDigest);

  // Drain the queued run so the next test's worker call claims its own job (claim() is global-FIFO).
  await worker.runOnce("upload-archive-authored-test", {
    analysis: { ensureSession: async () => {}, run: async () => {} },
  });
});

test("a tarball with no Dockerfile and no recipe to author is not built, and still queues the static analysis-only run", async () => {
  // No manifest the thin recipes cover, so nothing is authored. The build is skipped (not retried)
  // and the report gets its analysis-only run, the tier-3 static review (COULD_NOT_BUILD).
  const archive = tarGz([
    { name: "app.js", content: "console.log('no dockerfile here')\n" },
    { name: "README.md", content: "source without a Dockerfile\n" },
  ]);
  const reportId = await heldArchiveUpload(archive);
  await gate.approveUploadTarget(reportId, "reviewer", TARGET);
  const driver = fakeDriver("fail");

  await build.buildUploadOnce({ driver });
  assert.equal(driver.calls.length, 0);
  const upload = await uploadRow(reportId);
  assert.equal(upload.buildState, "FAILED");
  assert.match(upload.buildError ?? "", /no build recipe could be authored/);
  assert.equal((await reportRow(reportId)).targetProfileId, null);
  assert.ok(await analysisJob(reportId));

  // A run whose report has no bound target reaches the analysis driver, not a dead job.
  let ran = "";
  await worker.runOnce("upload-archive-fail-test", {
    analysis: { ensureSession: async () => {}, run: async ({ reportId: id }) => void (ran = id) },
  });
  assert.equal(ran, reportId);
});

test("an authored recipe whose build fails takes the same fail-safe path after its retry", async () => {
  const archive = tarGz([{ name: "package.json", content: '{"name":"broken"}\n' }]);
  const reportId = await heldArchiveUpload(archive);
  await gate.approveUploadTarget(reportId, "reviewer", TARGET);
  const driver = fakeDriver("fail");

  await build.buildUploadOnce({ driver });
  assert.equal((await uploadRow(reportId)).buildState, "PENDING");
  await build.buildUploadOnce({ driver });
  assert.equal((await uploadRow(reportId)).buildState, "FAILED");
  assert.equal((await reportRow(reportId)).targetProfileId, null);
  assert.ok(await analysisJob(reportId));

  await worker.runOnce("upload-archive-authored-fail-test", {
    analysis: { ensureSession: async () => {}, run: async () => {} },
  });
});

test("a Dockerfile inside the archive's wrapping directory builds with that directory as its context", async () => {
  const archive = tarGz([
    { name: "myapp/Dockerfile", content: "FROM nginx:1.27\n" },
    { name: "myapp/index.html", content: "<h1>hi</h1>\n" },
  ]);
  const reportId = await heldArchiveUpload(archive);
  await gate.approveUploadTarget(reportId, "reviewer", TARGET);

  const driver = fakeDriver();
  assert.ok(await build.buildUploadOnce({ driver }));
  const { plan } = driver.calls[0];
  assert.ok(plan.strategy === "dockerfile" && plan.buildContext === "myapp" && plan.dockerfilePath === "Dockerfile");

  await worker.runOnce("upload-archive-wrapped-test", {
    analysis: { ensureSession: async () => {}, run: async () => {} },
  });
});

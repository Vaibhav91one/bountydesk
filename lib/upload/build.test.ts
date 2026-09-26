import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import type { BuildDriver, BuildInput, BuildResult } from "@/lib/build-onboarding/build-driver";

/**
 * The reviewer-approved upload build against a real Postgres. The build driver is the one seam that
 * needs Daytona, a registry and a sandbox, so it is a fake here that records what it was asked to
 * build; everything after it (the connectionless bind, the report binding, the analysis job) is the
 * production code path.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let intake: typeof import("./intake");
let gate: typeof import("./gate");
let build: typeof import("./build");
let worker: typeof import("@/lib/jobs/worker");

const CONFIG = { perSenderPerDay: 50, perDomainPerDay: 50, maxBytes: 512 * 1024, exemptDomains: [] };
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const TARGET = { port: 8080, readinessPath: "/health" };

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("upload_build");
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

let n = 0;
async function heldUpload(fields: Record<string, string | Blob>): Promise<string> {
  n += 1;
  const data = new FormData();
  for (const [key, value] of Object.entries({
    title: `upload ${n}`,
    body: "report body",
    contact: `builder${n}@outside.test`,
    ...fields,
  })) {
    data.set(key, value);
  }
  const parsed = await intake.parseUploadForm(data, CONFIG);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
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
      if (outcome === "fail") throw new Error("docker build exited 1");
      const source = input.source!;
      const anchor = source.kind === "image" ? source.imageDigest : source.kind === "archive" ? source.sourceArchiveDigest : "";
      return {
        imageName: `ghcr.io/ns/${input.repoFullName.replace("/", "-")}`,
        imageDigest: `sha256:${"d".repeat(64)}`,
        snapshotId: `snap-${n}`,
        dockerfileText: "FROM scratch\n",
        buildLog: "built",
        buildMarker: anchor,
        buildRecipeDigest: `sha256:${"e".repeat(64)}`,
        ...(source.kind === "archive" ? { sourceArchiveDigest: source.sourceArchiveDigest } : {}),
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

test("nothing builds while the report waits at the gate", async () => {
  await heldUpload({ imageRef: "ghcr.io/vendor/app:1", imageDigest: IMAGE_DIGEST });
  const driver = fakeDriver();
  assert.equal(await build.buildUploadOnce({ driver }), null);
  assert.equal(driver.calls.length, 0);
});

test("a released upload with approved image material builds, binds through the connectionless path, and runs", async () => {
  const reportId = await heldUpload({ imageRef: "ghcr.io/vendor/app:1", imageDigest: IMAGE_DIGEST });
  assert.deepEqual(await gate.approveUploadTarget(reportId, "reviewer", TARGET), { ok: true });
  assert.equal((await reportRow(reportId)).state, "TRIAGING");

  const driver = fakeDriver();
  assert.ok(await build.buildUploadOnce({ driver }));

  // The driver was handed the upload's own material, never anything from a request.
  assert.equal(driver.calls.length, 1);
  assert.deepEqual(driver.calls[0].source, { kind: "image", imageRef: "ghcr.io/vendor/app:1", imageDigest: IMAGE_DIGEST });
  assert.equal(driver.calls[0].plan.strategy, "image");

  const row = await reportRow(reportId);
  assert.ok(row.targetProfileId);
  assert.equal(row.connectedRepositoryId, null);
  const [profile] = await dbm.db
    .select()
    .from(dbm.targetProfile)
    .where(dbm.eq(dbm.targetProfile.id, row.targetProfileId!));
  assert.equal(profile.name, gate.uploadTargetName(reportId));
  assert.deepEqual(profile.scopeRules, [{ allow: "localhost" }]);
  const config = profile.config as { baseUrl: string; provisioning: { expectedBuildMarker: string; readinessPath: string } };
  assert.equal(config.baseUrl, "http://localhost:8080");
  assert.equal(config.provisioning.readinessPath, "/health");
  assert.equal(config.provisioning.expectedBuildMarker, IMAGE_DIGEST);

  assert.equal((await uploadRow(reportId)).buildState, "BUILT");
  const job = await analysisJob(reportId);
  assert.ok(job);

  // The queued run is the gate release the jobs worker already knows, now accepted for an upload.
  let ran = "";
  await worker.runOnce("upload-build-test", {
    analysis: { ensureSession: async () => {}, run: async ({ reportId: id }) => void (ran = id) },
  });
  assert.equal(ran, reportId);
});

test("an uploaded Dockerfile builds from its one-file archive on the archive digest", async () => {
  const reportId = await heldUpload({ dockerfile: new Blob(["FROM nginx:1.27\n"]) });
  assert.deepEqual(
    await gate.approveUploadTarget(reportId, "reviewer", { ...TARGET, ecosystem: "node", startCommand: "nginx -g 'daemon off;'" }),
    { ok: true },
  );
  const driver = fakeDriver();
  await build.buildUploadOnce({ driver });

  const source = driver.calls[0].source;
  assert.equal(source?.kind, "archive");
  assert.equal(driver.calls[0].plan.ecosystem, "node");
  const upload = await uploadRow(reportId);
  assert.ok(source?.kind === "archive");
  assert.equal(source.sourceArchiveDigest, upload.sourceArchiveDigest);
  // The bytes survive the bytea round trip: the real driver re-hashes them before staging.
  const { createHash } = await import("node:crypto");
  assert.equal(`sha256:${createHash("sha256").update(source.archive).digest("hex")}`, upload.sourceArchiveDigest);
  const [profile] = await dbm.db
    .select()
    .from(dbm.targetProfile)
    .where(dbm.eq(dbm.targetProfile.name, gate.uploadTargetName(reportId)));
  assert.equal(profile.sourceArchiveDigest, upload.sourceArchiveDigest);
});

test("a build that keeps failing leaves the report unbound and still queues its analysis-only run", async () => {
  const reportId = await heldUpload({ imageRef: "nginx:1.27", imageDigest: IMAGE_DIGEST });
  await gate.approveUploadTarget(reportId, "reviewer", TARGET);
  const driver = fakeDriver("fail");

  await build.buildUploadOnce({ driver });
  assert.equal((await uploadRow(reportId)).buildState, "PENDING");
  assert.equal(await analysisJob(reportId), undefined);

  await build.buildUploadOnce({ driver });
  const upload = await uploadRow(reportId);
  assert.equal(upload.buildState, "FAILED");
  assert.match(upload.buildError ?? "", /docker build exited 1/);
  assert.equal((await reportRow(reportId)).targetProfileId, null);
  assert.ok(await analysisJob(reportId));
});

test("a target bound by hand while the build waits is not mistaken for this upload's build", async () => {
  const reportId = await heldUpload({ imageRef: "nginx:1.27", imageDigest: IMAGE_DIGEST });
  await gate.approveUploadTarget(reportId, "reviewer", TARGET);
  const [other] = await dbm.db
    .insert(dbm.targetProfile)
    .values({ name: `unrelated-${n}`, imageDigest: `sha256:${"f".repeat(64)}` })
    .returning({ id: dbm.targetProfile.id });
  const { bindTarget } = await import("@/lib/targets/bind");
  assert.equal((await bindTarget(reportId, other.id, "reviewer")).ok, true);

  const driver = fakeDriver();
  await build.buildUploadOnce({ driver });
  assert.equal(driver.calls.length, 0);
  const upload = await uploadRow(reportId);
  assert.equal(upload.buildState, "FAILED");
  assert.match(upload.buildError ?? "", /uploaded material was not built/);
  // The reviewer's choice stands, and the report still gets its run.
  assert.equal((await reportRow(reportId)).targetProfileId, other.id);
  assert.ok(await analysisJob(reportId));
});

test("approval refuses bad target settings, uploads with no material, and a second approval", async () => {
  const bare = await heldUpload({});
  assert.deepEqual(await gate.approveUploadTarget(bare, "reviewer", TARGET), {
    ok: false,
    reason: "this upload carried no target material to build",
  });

  const reportId = await heldUpload({ imageRef: "nginx:1.27", imageDigest: IMAGE_DIGEST });
  assert.equal((await gate.approveUploadTarget(reportId, "reviewer", { ...TARGET, port: 0 })).ok, false);
  assert.equal((await gate.approveUploadTarget(reportId, "reviewer", { ...TARGET, readinessPath: "http://evil" })).ok, false);
  assert.equal(
    (await gate.approveUploadTarget(reportId, "reviewer", { ...TARGET, startCommand: "docker run evil" })).ok,
    false,
  );
  assert.equal((await reportRow(reportId)).state, "NEEDS_DECISION");

  assert.deepEqual(await gate.approveUploadTarget(reportId, "reviewer", TARGET), { ok: true });
  assert.equal((await gate.approveUploadTarget(reportId, "reviewer", TARGET)).ok, false);
});

test("a prebuilt image whose registry is not allowed never reaches a build", async () => {
  const { resolveBuildSource } = await import("@/lib/build-onboarding/daytona-build-driver");
  const plan = gate.uploadBuildPlan({ kind: "image", imageRef: "quay.io/org/app:1" }, "none");
  assert.throws(
    () =>
      resolveBuildSource({
        repoFullName: "upload/x",
        sourceRef: "upload:x",
        source: { kind: "image", imageRef: "quay.io/org/app:1", imageDigest: IMAGE_DIGEST },
        plan,
      }),
    /images from quay\.io are not accepted/,
  );
});

import { randomBytes } from "node:crypto";

import { requireEnv } from "@/lib/env";
import {
  BUILD_PURPOSE,
  createBuildSandbox,
  createSnapshot,
  DaytonaError,
  deleteSnapshotByName,
  deleteSandbox,
  execute,
  PURPOSE_LABEL,
  waitForSnapshotActive,
  type CreateSnapshotSpec,
  type ExecResult,
  type Sandbox,
  type SnapshotInfo,
} from "@/lib/sandbox/daytona";

import { createHash } from "node:crypto";

import type { BuildPlan } from "./build-plan";
import {
  onboardingSnapshotImageRef,
  type BuildDriver,
  type BuildInput,
  type BuildResult,
  type BuildSource,
  type BuiltService,
} from "./build-driver";
import { synthesizeComposeDockerfile } from "./compose-compiler";
import { getDatastoreRecipe, type DatastoreCreds } from "./datastore-recipes";
import { meshBuildPlan } from "./mesh-build-plan";
import { isCommitSha, isSha256Digest, sourceIdentityDigest } from "./source-identity";
import { resolveRegistry, type RegistryHandoff, type SandboxRun } from "./registry";
import { selectEgressHosts } from "./egress-profiles";

/**
 * The one implementation of BuildDriver that touches live infrastructure.
 *
 * It boots a Docker-in-Docker build sandbox with a per-ecosystem egress allow-list, clones the
 * source, produces one image according to the build plan's strategy (the repo's own Dockerfile, a
 * published base image, or a compose app compiled with its datastore bundled and seeded), bakes the
 * source commit as a build marker, pushes to a ghcr tag, registers a Daytona snapshot, and tears the
 * sandbox down. Everything network-facing lives here; the rest of the pipeline never grants egress.
 *
 * Config, all server-held: BUILD_BASE_SNAPSHOT (a DinD snapshot to build inside), GHCR_PUSH_TOKEN,
 * GHCR_NAMESPACE. The egress allow-list is chosen per ecosystem in code (egress-profiles.ts), unioned
 * with an optional BUILD_EGRESS_ALLOWLIST for an ad-hoc host.
 */
const BUILD_CPU = numEnv("BUILD_CPU", 2);
const BUILD_MEMORY_GB = numEnv("BUILD_MEMORY_GB", 4);
const BUILD_DISK_GB = numEnv("BUILD_DISK_GB", 10);
const BUILD_TTL_MINUTES = numEnv("BUILD_TTL_MINUTES", 30);
const BUILD_TIMEOUT_S = 300;

const APP_STAGE_TAG = "bountydesk-app-stage";
const MARKER_PATH = "/etc/bountydesk-build-marker";

// Forward the sandbox's egress-proxy env into a build's RUN steps (nested containers do not inherit
// it), so package fetches inside RUN reach the proxy instead of going direct and being refused.
// --progress=plain makes BuildKit emit plain line-based logs to the captured stream: its default
// progress UI detects the non-TTY exec and buffers into a stream the toolbox does not return, so a
// failed build otherwise comes back as "exit 1" with no diagnostic at all.
const PROXY_BUILD_ARGS =
  "--progress=plain " +
  ["http_proxy", "https_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]
    .map((name) => `--build-arg ${name}`)
    .join(" ");

/**
 * The build sandbox reaches its allow-listed package hosts through an egress proxy that terminates
 * TLS with its own CA (a MITM forward proxy). A package manager in a fresh base image has no reason
 * to trust that CA, so it rejects the connection with "unable to get local issuer certificate", even
 * though the host is allowed. The server-held egress allow-list is the real control over where a
 * build can reach, not the client's cert check of our own proxy, so relaxing that verification for
 * the known package hosts is safe: a build still cannot reach anything off the allow-list. This is
 * build-time only and inert in the offline reproduction image.
 *
 * Injected after each FROM because ENV does not cross a stage boundary. Covers pip (the case that
 * surfaced this), npm, and git; other tools that honour these standard vars benefit too.
 */
const PROXY_TRUST_ENV =
  'ENV PIP_TRUSTED_HOST="pypi.org files.pythonhosted.org" ' +
  'NODE_TLS_REJECT_UNAUTHORIZED="0" NPM_CONFIG_STRICT_SSL="false" GIT_SSL_NO_VERIFY="true"';

export function injectProxyTrust(dockerfileText: string): string {
  const withTrustEnv = dockerfileText.replace(/^([ \t]*FROM[ \t]+[^\n]+)$/gim, `$1\n${PROXY_TRUST_ENV}`);
  return withTrustEnv
    .split("\n")
    .map((line) => {
      if (!/^\s*RUN\s+/i.test(line) || /#/.test(line)) return line;
      return line.replace(
        /\bapk(?!\s+--no-check-certificate)(?=\s+(?:(?!&&|;|\bapk\b)[^\n])*\badd\b)/gi,
        "apk --no-check-certificate",
      );
    })
    .join("\n");
}

/**
 * A Dockerfile ENV line baking a mesh service's compose environment into its image, or "" when it
 * has none. compose applies a service's environment at run time; the reproduction sandbox boots the
 * image with none, so a datastore that needs POSTGRES_PASSWORD to initialise, or an app that reads
 * its DB host from the environment, must carry that config in the image. This is the test target's
 * own configuration (a datastore password like "postgres"), not a platform secret, and the image is
 * offline. A value that names a peer service (a DB host set to "db") is kept verbatim; the peer
 * resolves through /etc/hosts at provision time.
 */
export function dockerEnvLine(env: Record<string, string> | undefined): string {
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) return "";
  return "ENV " + entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ") + "\n";
}

/**
 * verifyNoEgress and waitForAppReady probe each node from inside with curl or wget. Minimal base
 * images (python:slim, and datastore images like postgres) ship neither, so a mesh built on them
 * cannot prove no egress or wait for readiness. Every mesh node's image therefore gets curl at build
 * time, best-effort across the common package managers; the build egress already allows the distro
 * mirrors. Meant to run as root (callers set USER root first).
 */
const ENSURE_PROBE_TOOL =
  "RUN if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then " +
  // A datastore image adds a vendor apt repo (postgres uses PGDG, mariadb/mysql and mongodb their
  // own) whose host is not on the build egress allow-list, so apt-get update fails on it and curl
  // never installs. Drop every vendor .list in sources.list.d so the update runs against the base
  // distro mirrors only; the base sources live in /etc/apt/sources.list or a .sources file and are
  // left in place, so this stays a no-op on an image with no vendor repo.
  "rm -f /etc/apt/sources.list.d/*.list 2>/dev/null || true; " +
  "(apt-get update && apt-get install -y --no-install-recommends curl) || (apk add --no-cache curl) || " +
  "(microdnf install -y curl) || (dnf install -y curl) || (yum install -y curl) || true; fi";

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function createDaytonaBuildDriver(): BuildDriver {
  return {
    async build(input: BuildInput): Promise<BuildResult> {
      // The source is resolved before any provider configuration is read: a source with no immutable
      // anchor must fail for that reason, not incidentally on a missing snapshot name.
      const source = resolveBuildSource(input);

      const plan = input.plan;
      if (plan.strategy === "not-flattenable") {
        throw new Error(`build called for a not-flattenable repo: ${plan.reason}`);
      }
      if (source.kind === "image" && plan.strategy === "compose-mesh") {
        throw new Error("a prebuilt image source builds one image, not a compose mesh");
      }

      const resolvedCommitSha = source.kind === "git" ? source.resolvedCommitSha : undefined;
      const sourceArchiveDigest = source.kind === "archive" ? source.sourceArchiveDigest : undefined;

      const baseSnapshot = requireEnv("BUILD_BASE_SNAPSHOT");
      const registry = resolveRegistry();
      // A prebuilt image may live on a registry outside the base allow-list; its host comes from the
      // validated ref, never from the plan or anything a reporter sent.
      const allowList = egressAllowList(plan, source.kind === "image" ? registryHostOf(source.imageRef) : undefined);

      const slug = repoSlug(input.repoFullName);
      const imageName = `${registry.namespace}/${slug}`;
      const imageRef = onboardingSnapshotImageRef(imageName);

      const sandbox = await createBuildSandbox(
        {
          snapshot: baseSnapshot,
          cpu: BUILD_CPU,
          memoryGb: BUILD_MEMORY_GB,
          diskGb: BUILD_DISK_GB,
          ttlMinutes: BUILD_TTL_MINUTES,
          labels: { [PURPOSE_LABEL]: BUILD_PURPOSE, "bountydesk.repo": input.repoFullName },
        },
        allowList,
      );
      // Recorded at the top of the stored build log, so a reviewer approving the manifest can see
      // when a build ran under Daytona's organization policy instead of this plan's allow-list.
      const egressNote =
        sandbox.egressPolicy === "organization-policy"
          ? "[egress] Daytona organization policy: this account's tier refused a per-sandbox allow-list, and the sandbox was checked to have no open internet.\n\n"
          : "";

      try {
        // A prebuilt image has no source to stage; its marker is its own digest, baked in below.
        const { buildMarker } =
          source.kind === "image" ? { buildMarker: source.imageDigest } : await stageSource(run, sandbox, source);

        await startDockerDaemon(sandbox);

        // A mesh builds one image per service and registers one snapshot each, so it owns the whole
        // push-and-register flow rather than the single-image path below.
        if (plan.strategy === "compose-mesh" && source.kind !== "image") {
          const mesh = await buildMesh(sandbox, plan, {
            registry,
            slug,
            buildMarker,
            ...(resolvedCommitSha ? { resolvedCommitSha } : {}),
            ...(sourceArchiveDigest ? { sourceArchiveDigest } : {}),
          });
          return { ...mesh, buildLog: `${egressNote}${mesh.buildLog}` };
        }

        const { dockerfileText, buildLog } =
          source.kind === "image"
            ? await buildPrebuiltImage(sandbox, source, imageRef)
            : await buildImage(sandbox, plan as Exclude<typeof plan, { strategy: "compose-mesh" }>, imageRef, buildMarker);

        // The registry introduces the push credential right before the push and drops it right
        // after, so the untrusted build ran with no reusable token in the sandbox.
        const { pullableTag, digest } = await registry.push(sandbox, imageRef, run);

        // A rebuild of the same target reuses this deterministic name, and Daytona refuses a create
        // that collides with an existing snapshot. Replace the prior one rather than fail on it.
        await deleteSnapshotByName(`onboarding-${slug}`);
        const snapshot = await createSnapshot({
          name: `onboarding-${slug}`,
          image: pullableTag,
          cpu: BUILD_CPU,
          memoryGb: BUILD_MEMORY_GB,
          diskGb: BUILD_DISK_GB,
        });

        // Daytona materialises the snapshot's image at registration, so the origin registry tag is no
        // longer needed to boot the target once the snapshot is active. Reclaim it, best-effort.
        await reclaimOriginImage(registry, snapshot.id, pullableTag);

        return {
          imageName,
          imageDigest: digest,
          snapshotId: snapshot.id,
          dockerfileText,
          buildLog: `${egressNote}${buildLog}`,
          buildMarker,
          buildRecipeDigest: buildRecipeDigest(plan, buildMarker, digest, {
            repoFullName: input.repoFullName,
            ...(resolvedCommitSha ? { resolvedCommitSha } : {}),
            ...(sourceArchiveDigest ? { sourceArchiveDigest } : {}),
          }),
          ...(resolvedCommitSha ? { resolvedCommitSha } : {}),
          ...(sourceArchiveDigest ? { sourceArchiveDigest } : {}),
        };
      } finally {
        await deleteSandbox(sandbox.id).catch(() => undefined);
      }
    },
  };
}

/**
 * Turn a source into the build sandbox at /work/source and return the marker that pins it. A git
 * source clones and checks out the exact commit and re-reads HEAD to prove it landed; an uploaded
 * archive is written from its verified bytes and its digest re-checked inside the sandbox, so a
 * corrupt or swapped upload fails here rather than being built. A prebuilt image never reaches this;
 * it is not staged.
 */
export async function stageSource(
  run: SandboxRun,
  sandbox: Sandbox,
  source: Exclude<BuildSource, { kind: "image" }>,
): Promise<{ buildMarker: string }> {
  if (source.kind === "git") {
    await run(sandbox, `git clone --no-checkout ${shellArg(source.cloneUrl)} /work/source`);
    await run(sandbox, `cd /work/source && git checkout --detach ${shellArg(source.resolvedCommitSha)}`);
    const head = (await run(sandbox, "cd /work/source && git rev-parse HEAD")).result.trim();
    if (head.toLowerCase() !== source.resolvedCommitSha.toLowerCase()) {
      throw new Error(`cloned source resolved to ${head}, expected ${source.resolvedCommitSha}`);
    }
    return { buildMarker: source.resolvedCommitSha };
  }

  // The trusted controller resolved the archive's digest from the bytes it holds; re-hash here so a
  // pin can never be asserted for bytes that do not match, then re-check inside the sandbox that the
  // exact bytes landed intact. The marker baked into the image is the archive digest, the immutable
  // anchor a non-git source has in place of a commit.
  const actual = `sha256:${createHash("sha256").update(source.archive).digest("hex")}`;
  if (actual !== source.sourceArchiveDigest.toLowerCase()) {
    throw new Error(`source archive digest ${actual} does not match the declared ${source.sourceArchiveDigest}`);
  }
  // ponytail: the archive is base64'd into one exec argument, fine for the small test-app tarballs
  // this handles; chunk the write if a large upload ever hits the shell's argument-length cap.
  const b64 = source.archive.toString("base64");
  const expectedHex = source.sourceArchiveDigest.slice("sha256:".length).toLowerCase();
  await run(sandbox, `echo ${shellArg(b64)} | base64 -d > /work/source.tgz`);
  await run(
    sandbox,
    `actual=$(sha256sum /work/source.tgz | cut -d' ' -f1); [ "$actual" = ${shellArg(expectedHex)} ] || { echo "staged archive digest $actual != ${expectedHex}" >&2; exit 1; }`,
  );
  // -xf autodetects the compression, so a plain tar and a gzipped tarball both extract. The archive
  // is expected to hold the project at its root, matching where a clone lands it.
  await run(sandbox, "mkdir -p /work/source && tar -xf /work/source.tgz -C /work/source");
  return { buildMarker: source.sourceArchiveDigest };
}

/**
 * The one-layer Dockerfile a prebuilt image is rebuilt from. Pulling `repo@digest` pins the exact bytes
 * the caller named: a digest that does not exist on the registry fails the pull, and a tag that has
 * since moved is never consulted. The marker baked in is the image digest, which is also what the
 * profile records as its expected build marker, so buildMarkerCheck can re-prove at reproduction that
 * the booted image is this build. `USER root` matches the other strategies: the marker is written to
 * /etc and the offline target then runs as root, fine for a test target.
 */
export function prebuiltImageDockerfile(source: Extract<BuildSource, { kind: "image" }>): string {
  return [
    `FROM ${imageNameFromRef(source.imageRef)}@${source.imageDigest}`,
    "USER root",
    `RUN mkdir -p /etc && echo ${shArgDockerfile(source.imageDigest)} > ${MARKER_PATH}`,
    "",
  ].join("\n");
}

async function buildPrebuiltImage(
  sandbox: Sandbox,
  source: Extract<BuildSource, { kind: "image" }>,
  imageRef: string,
): Promise<{ dockerfileText: string; buildLog: string }> {
  const dockerfileText = prebuiltImageDockerfile(source);
  await writeGenDockerfile(sandbox, dockerfileText);
  const log = (await run(sandbox, `cd /work/gen && docker build ${PROXY_BUILD_ARGS} -t ${imageRef} .`)).result;
  return { dockerfileText, buildLog: log.slice(-BUILD_LOG_CAP) };
}

/**
 * The registry host a prebuilt image is pulled from, when it names one. A reference whose first path
 * segment has a dot, a port, or is `localhost` names its registry (ghcr.io/x/y, host:5000/app); anything
 * else is Docker Hub, which the base allow-list already covers. The port is dropped because the build
 * allow-list takes bare domains.
 */
export function registryHostOf(imageRef: string): string | undefined {
  const slash = imageRef.indexOf("/");
  if (slash < 0) return undefined;
  const first = imageRef.slice(0, slash);
  if (!first.includes(".") && !first.includes(":") && first !== "localhost") return undefined;
  const host = first.split(":")[0].toLowerCase();
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host) ? host : undefined;
}

/**
 * Decide how the source reaches the build. An explicit source (a non-GitHub onboarding path) is
 * validated for a usable anchor; otherwise the driver falls back to the GitHub clone path, which
 * needs a server-resolved commit. A source with no immutable anchor is refused here, before any
 * sandbox or provider call.
 */
export function resolveBuildSource(input: BuildInput): BuildSource {
  const source = input.source;
  if (source) {
    if (source.kind === "git" && !isCommitSha(source.resolvedCommitSha)) {
      throw new Error("a git source requires a server-resolved 40-character commit SHA");
    }
    if (source.kind === "archive" && !isSha256Digest(source.sourceArchiveDigest)) {
      throw new Error("an archive source requires a sha256 source archive digest");
    }
    if (
      source.kind === "image" &&
      (!isSha256Digest(source.imageDigest) || source.imageRef.includes("@sha256:") || !isSafeImageRef(source.imageRef))
    ) {
      throw new Error("a prebuilt image source requires a plain tag reference and its own sha256 digest");
    }
    return source;
  }
  if (!isCommitSha(input.resolvedCommitSha)) {
    throw new Error(
      "onboarding build requires an identity anchor: a server-resolved 40-character commit SHA or a source archive digest",
    );
  }
  return {
    kind: "git",
    // The clone target is the server-held repository name, not any caller-supplied ref, so nothing
    // can redirect the clone to a different repository than this onboarding row is for.
    cloneUrl: `https://github.com/${input.repoFullName}.git`,
    resolvedCommitSha: input.resolvedCommitSha,
  };
}

/**
 * A prebuilt image ref reaches the Daytona API and is stored on the profile, and its untagged name is
 * later compared against a snapshot's imageName. It is server-authored, but this keeps the reference to
 * the characters a registry reference actually uses so a stray value with a space or a shell
 * metacharacter is refused at the boundary rather than carried downstream. Only the repository half is
 * used: the image is pulled by digest, so the tag itself is never trusted.
 */
const SAFE_IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export function isSafeImageRef(ref: string): boolean {
  return ref.length <= 512 && SAFE_IMAGE_REF.test(ref);
}

/** Strip the tag off an image reference to get its untagged name, e.g. ghcr.io/x/y:tag -> ghcr.io/x/y.
 *  A registry port (host:5000/img) is left alone: only a colon in the final path segment is a tag. */
export function imageNameFromRef(ref: string): string {
  const slash = ref.lastIndexOf("/");
  const lastSegColon = ref.indexOf(":", slash + 1);
  return lastSegColon >= 0 ? ref.slice(0, lastSegColon) : ref;
}

/** Cap on the captured build log kept on the row for download. BuildKit is chatty; the tail is what a
 *  reviewer wants, so keep the last slice rather than the whole thing. */
const BUILD_LOG_CAP = 64_000;

/**
 * The provider operations the mesh builder performs, behind an interface so its orchestration is
 * tested deterministically without a live Daytona account or registry. The live wiring is the
 * default; a test passes fakes and asserts the command transcript.
 */
export type MeshBuildRuntime = {
  /** `run` keeps the live helper's contract: it throws on a non-zero exit, so a caller never has to
   *  check an exit code. A fake that returns a failed ExecResult instead would let a broken build
   *  silently continue. */
  run(sandbox: Sandbox, command: string): Promise<ExecResult>;
  createSnapshot(spec: CreateSnapshotSpec): Promise<SnapshotInfo>;
  deleteSnapshotByName(name: string): Promise<void>;
};

const liveMeshRuntime: MeshBuildRuntime = { run, createSnapshot, deleteSnapshotByName };

/**
 * Build a compose-mesh: one image per service, one snapshot per service. A service with a build
 * context is built from the repo and pushed to ghcr with the marker baked in; a service that names a
 * stock image is pulled (to capture its digest) and its public tag is registered as a snapshot
 * directly. The returned BuildResult mirrors the app service at the top level so the single-image
 * consumers keep working, and carries every service in `services` for the mesh provisioner.
 */
export async function buildMesh(
  sandbox: Sandbox,
  plan: Extract<BuildPlan, { strategy: "compose-mesh" }>,
  ctx: {
    registry: RegistryHandoff;
    slug: string;
    buildMarker: string;
    resolvedCommitSha?: string;
    sourceArchiveDigest?: string;
    runtime?: MeshBuildRuntime;
  },
): Promise<BuildResult> {
  const runtime = ctx.runtime ?? liveMeshRuntime;
  const services: BuiltService[] = [];
  let app: BuiltService | undefined;
  let appDockerfileText = "";
  let appBuildLog = "";

  // A tag unique to this build. The onboarding tag is otherwise reused across builds of a repo, and
  // Daytona caches a snapshot's image by tag: a rebuild that changed the image (adding curl) but kept
  // the tag was served the stale, cached image, so a node came up without curl. A fresh tag per build
  // forces Daytona to pull the image this build actually produced.
  const buildTag = `bountydesk-${randomBytes(4).toString("hex")}`;

  const plannedServices = meshBuildPlan(plan, {
    ghcrNamespace: ctx.registry.namespace,
    slug: ctx.slug,
    buildTag,
  });
  for (const planned of plannedServices) {
    const svc = plan.services.find((service) => service.service === planned.service)!;
    const serviceSlug = `${ctx.slug}-${svc.service}`;
    const common = {
      service: svc.service,
      role: svc.role,
      ...(svc.port !== undefined ? { port: svc.port } : {}),
      ...(svc.env ? { env: svc.env } : {}),
      ...(svc.peers ? { peers: svc.peers } : {}),
    };

    if (svc.build) {
      const context = planned.build!.context;
      const dockerfile = planned.build!.dockerfile;
      const imageName = planned.imageName;
      const imageRef = planned.imageTag;
      const stageTag = `bountydesk-mesh-${svc.service}`;
      // A service Dockerfile the onboarding agent authored is not in the cloned repo, so write it
      // into the context first; the deterministic classifier leaves this unset and uses the repo's.
      if (planned.build?.dockerfileText) {
        const authored = Buffer.from(planned.build.dockerfileText, "utf8").toString("base64");
        await runtime.run(sandbox, `mkdir -p /work/source/${context} && echo ${shellArg(authored)} | base64 -d > /work/source/${context}/${dockerfile}`);
      }
      // Relax the proxy TLS check for package hosts (see PROXY_TRUST_ENV), then bake the marker,
      // pinned to root because a service Dockerfile may end on a non-root USER, so reproduction can
      // prove which build booted this service. Build from a derived Dockerfile so the customer's
      // file on disk is left untouched.
      const original = (await runtime.run(sandbox, `cat /work/source/${context}/${dockerfile}`)).result;
      const dfText =
        injectProxyTrust(original) +
        `\nUSER root\n${ENSURE_PROBE_TOOL}\n${dockerEnvLine(svc.env)}RUN mkdir -p /etc && echo ${shArgDockerfile(ctx.buildMarker)} > ${MARKER_PATH}\n`;
      const prepared = Buffer.from(dfText, "utf8").toString("base64");
      await runtime.run(sandbox, `echo ${shellArg(prepared)} | base64 -d > /work/source/${context}/Dockerfile.bountydesk`);
      const log = (
        await runtime.run(sandbox, `cd /work/source/${context} && docker build -f Dockerfile.bountydesk ${PROXY_BUILD_ARGS} -t ${stageTag} .`)
      ).result;
      // Capture the service's real start command, then rebuild with an idle entrypoint so the image
      // does not auto-start before the provisioner has wired its peers. The provisioner runs this.
      const startCommand = await inspectMeshStartCommand(sandbox, stageTag, svc, runtime);
      await writeGenDockerfile(sandbox, `FROM ${stageTag}\nENTRYPOINT ["tail", "-f", "/dev/null"]\nCMD []\n`, runtime);
      await runtime.run(sandbox, `cd /work/gen && docker build -t ${imageRef} .`);
      const imageDigest = await pushAndDigest(sandbox, imageRef, ctx.registry, runtime);
      const snapshotId = await registerServiceSnapshot(serviceSlug, imageRef, runtime);
      const built: BuiltService = {
        ...common,
        imageName,
        imageDigest,
        snapshotId,
        snapshotImageRef: imageRef,
        buildMarker: ctx.buildMarker,
        startCommand,
      };
      services.push(built);
      if (svc.role === "app") {
        app = built;
        appDockerfileText = dfText;
        appBuildLog = log;
      }
    } else {
      const image = planned.image!;
      const imageName = planned.imageName;
      const imageRef = planned.imageTag;
      // Derive an image that adds curl (for the egress and readiness probes) so a minimal datastore
      // image still verifies, and push it under our own immutable tag. This also avoids Daytona
      // rejecting a snapshot of a :latest service image. The datastore keeps its own entrypoint, so
      // it still auto-starts, and gets no marker (it is not a build we prove identity for).
      await runtime.run(sandbox, `docker pull ${shellArg(image)}`);
      await writeGenDockerfile(sandbox, `FROM ${image}\nUSER root\n${ENSURE_PROBE_TOOL}\n${dockerEnvLine(svc.env)}`, runtime);
      await runtime.run(sandbox, `cd /work/gen && docker build ${PROXY_BUILD_ARGS} -t ${imageRef} .`);
      // Daytona runs a sandbox's own init as pid 1 and the image entrypoint without its cmd, so a
      // datastore (postgres's entrypoint needs the "postgres" arg) does not start on its own. Capture
      // its full start command (entrypoint plus cmd) so the provisioner runs it.
      const startCommand = await inspectMeshStartCommand(sandbox, imageRef, svc, runtime);
      const imageDigest = await pushAndDigest(sandbox, imageRef, ctx.registry, runtime);
      const snapshotId = await registerServiceSnapshot(serviceSlug, imageRef, runtime);
      services.push({ ...common, imageName, imageDigest, snapshotId, snapshotImageRef: imageRef, startCommand });
    }
  }

  if (!app) throw new Error("compose-mesh build produced no app service");
  return {
    imageName: app.imageName,
    imageDigest: app.imageDigest,
    snapshotId: app.snapshotId,
    dockerfileText: appDockerfileText,
    buildLog: appBuildLog.slice(-BUILD_LOG_CAP),
    buildMarker: ctx.buildMarker,
    buildRecipeDigest: buildRecipeDigest(plan, ctx.buildMarker, app.imageDigest, {
      ...(ctx.resolvedCommitSha ? { resolvedCommitSha: ctx.resolvedCommitSha } : {}),
      ...(ctx.sourceArchiveDigest ? { sourceArchiveDigest: ctx.sourceArchiveDigest } : {}),
      serviceDigests: services.map((service) => ({
        service: service.service,
        imageDigest: service.imageDigest,
        snapshotId: service.snapshotId,
      })),
    }),
    ...(ctx.resolvedCommitSha ? { resolvedCommitSha: ctx.resolvedCommitSha } : {}),
    ...(ctx.sourceArchiveDigest ? { sourceArchiveDigest: ctx.sourceArchiveDigest } : {}),
    services,
  };
}

/** Push a built image through the registry and return its pushed digest. The registry keeps the push
 *  credential inside the login/push/logout window, so no untrusted build step held a reusable token. */
async function pushAndDigest(
  sandbox: Sandbox,
  imageRef: string,
  registry: RegistryHandoff,
  runtime: MeshBuildRuntime,
): Promise<string> {
  const { digest } = await registry.push(sandbox, imageRef, runtime.run);
  return digest;
}

/**
 * Reclaim the origin registry image once its snapshot has materialised.
 *
 * Daytona pulls a snapshot's image eagerly at registration (see waitForSnapshotActive), so once the
 * snapshot is active the origin tag is dead weight, not something a reproduction still pulls from.
 * Best-effort: a snapshot that never reports active, or a registry with no delete credential, leaves
 * the image in place rather than failing a build that already produced a verified snapshot.
 */
async function reclaimOriginImage(
  registry: RegistryHandoff,
  snapshotId: string,
  pullableTag: string,
): Promise<void> {
  try {
    await waitForSnapshotActive(snapshotId);
    await registry.deleteImage(pullableTag);
  } catch (error) {
    console.warn(`could not reclaim origin image ${pullableTag}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Register (or replace) a Daytona snapshot for one mesh service under a deterministic name. Daytona's
 *  delete is eventually consistent, so a create right after a delete can still 409 on the name (more
 *  likely with a mesh's several snapshots); delete again and retry a few times before giving up. */
async function registerServiceSnapshot(
  serviceSlug: string,
  image: string,
  runtime: MeshBuildRuntime,
): Promise<string> {
  const name = `onboarding-${serviceSlug}`;
  // Delete once. Onboarding is single-flight per repo (a leased row), so this name belongs to this
  // build; deleting again on each retry could remove a snapshot another build just created under the
  // same name, so on a 409 we only wait for the delete to propagate and retry the create.
  await runtime.deleteSnapshotByName(name);
  for (let attempt = 1; ; attempt++) {
    try {
      const snapshot = await runtime.createSnapshot({ name, image, cpu: BUILD_CPU, memoryGb: BUILD_MEMORY_GB, diskGb: BUILD_DISK_GB });
      return snapshot.id;
    } catch (error) {
      if (error instanceof DaytonaError && error.status === 409 && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        continue;
      }
      throw error;
    }
  }
}

/** Build the one image `imageRef` from the plan's strategy, and return the Dockerfile that built it
 *  (stored durably and offered for download) plus the captured build output. */
async function buildImage(
  sandbox: Sandbox,
  plan: Extract<BuildPlan, { strategy: "dockerfile" | "image" | "compose-synth" | "agent-authored" }>,
  imageRef: string,
  buildMarker: string,
): Promise<{ dockerfileText: string; buildLog: string }> {
  // Capture every `docker build` step's output, so a reviewer can download the log that produced the
  // pinned image (on a failed build the short reason still goes to last_error via run()).
  const buildLogs: string[] = [];
  const dockerBuild = async (command: string) => {
    buildLogs.push((await run(sandbox, command)).result);
  };
  const captured = () => ({ buildLog: buildLogs.join("\n\n").slice(-BUILD_LOG_CAP) });

  if (plan.strategy === "agent-authored") {
    // The agent converged on this Dockerfile by iterating in its own throwaway sandbox; the driver
    // rebuilds it here, against the repo it clones, for the pinned artifact. Write it into the context
    // via a base64 pipe (arbitrary text, intact), append the marker layer pinned to root (the agent's
    // Dockerfile may end on a non-root USER), then build.
    const context = plan.buildContext;
    const b64 = Buffer.from(injectProxyTrust(plan.dockerfileText), "utf8").toString("base64");
    await run(
      sandbox,
      `echo ${shellArg(b64)} | base64 -d > /work/source/${context}/Dockerfile.bountydesk`,
    );
    await run(
      sandbox,
      `printf 'USER root\\nRUN mkdir -p /etc && echo %s > ${MARKER_PATH}\\n' ${shellArg(buildMarker)} >> /work/source/${context}/Dockerfile.bountydesk`,
    );
    const dockerfileText = (await run(sandbox, `cat /work/source/${context}/Dockerfile.bountydesk`)).result;
    await dockerBuild(
      `cd /work/source/${context} && docker build -f Dockerfile.bountydesk ${PROXY_BUILD_ARGS} -t ${imageRef} .`,
    );
    return { dockerfileText, ...captured() };
  }

  if (plan.strategy === "dockerfile") {
    const dockerfilePath = plan.dockerfilePath;
    const context = plan.buildContext;
    // Relax the proxy TLS check for package hosts (see PROXY_TRUST_ENV), then append the marker
    // layer, pinned to root because a Dockerfile may end on a non-root USER that cannot write /etc;
    // the offline target then runs as root, fine for a test target. Build from a derived Dockerfile
    // so the customer's file on disk is left untouched.
    const original = (await run(sandbox, `cat /work/source/${context}/${dockerfilePath}`)).result;
    const dockerfileText =
      injectProxyTrust(original) +
      `\nUSER root\nRUN mkdir -p /etc && echo ${shArgDockerfile(buildMarker)} > ${MARKER_PATH}\n`;
    const prepared = Buffer.from(dockerfileText, "utf8").toString("base64");
    await run(sandbox, `echo ${shellArg(prepared)} | base64 -d > /work/source/${context}/Dockerfile.bountydesk`);
    const buildArgs = renderBuildArgs(plan.buildArgs);
    await dockerBuild(
      `cd /work/source/${context} && docker build -f Dockerfile.bountydesk ${PROXY_BUILD_ARGS} ${buildArgs} -t ${imageRef} .`,
    );
    return { dockerfileText, ...captured() };
  }

  if (plan.strategy === "image") {
    const dockerfile = [
      `FROM ${plan.baseImage}`,
      "USER root",
      `RUN mkdir -p /etc && echo ${shArgDockerfile(buildMarker)} > ${MARKER_PATH}`,
      "",
    ].join("\n");
    await writeGenDockerfile(sandbox, dockerfile);
    await dockerBuild(`cd /work/gen && docker build ${PROXY_BUILD_ARGS} -t ${imageRef} .`);
    return { dockerfileText: dockerfile, ...captured() };
  }

  // compose-synth: build the app service first, then the synthesized image FROM it. Relax the proxy
  // TLS check for package hosts on the app build too (see PROXY_TRUST_ENV), via a derived Dockerfile.
  const context = plan.appContext ?? ".";
  const appDockerfile = plan.appDockerfile ?? "Dockerfile";
  const appOriginal = (await run(sandbox, `cat /work/source/${context}/${appDockerfile}`)).result;
  const appPrepared = Buffer.from(injectProxyTrust(appOriginal), "utf8").toString("base64");
  await run(sandbox, `echo ${shellArg(appPrepared)} | base64 -d > /work/source/${context}/Dockerfile.bountydesk-app`);
  await dockerBuild(
    `cd /work/source/${context} && docker build -f Dockerfile.bountydesk-app ${PROXY_BUILD_ARGS} -t ${APP_STAGE_TAG} .`,
  );
  const appStartCommand = await inspectStartCommand(sandbox, APP_STAGE_TAG);
  const appPort = portFromBaseUrl(plan.runtime?.baseUrl);
  const datastores = plan.datastores.map((d) => {
    const recipe = getDatastoreRecipe(d.engine);
    if (!recipe) throw new Error(`no datastore recipe for ${d.engine}`);
    return { recipe, creds: credsFor(d, plan) };
  });

  const dockerfile = synthesizeComposeDockerfile({
    appImageRef: APP_STAGE_TAG,
    datastores,
    ...(plan.configRewrites ? { configRewrites: plan.configRewrites } : {}),
    ...(plan.envOverrides ? { envOverrides: plan.envOverrides } : {}),
    seed: plan.seed ?? { kind: "none" },
    buildMarker,
    appStartCommand,
    appPort,
  });
  await writeGenDockerfile(sandbox, dockerfile);
  await dockerBuild(`cd /work/gen && docker build ${PROXY_BUILD_ARGS} -t ${imageRef} .`);
  return { dockerfileText: dockerfile, ...captured() };
}

/** The datastore credentials the app expects: the compose-declared values, or a stable default when
 *  the compose file left them implicit (an app reading them from the same env we set). */
function credsFor(
  datastore: { dbName?: string; user?: string; password?: string },
  plan: Extract<BuildPlan, { strategy: "compose-synth" }>,
): DatastoreCreds {
  const base = plan.runtime?.name ?? "app";
  return {
    dbName: datastore.dbName ?? base,
    user: datastore.user ?? base,
    password: datastore.password ?? "bountydesk",
  };
}

/** Read the app image's default command (its CMD, or its ENTRYPOINT) so the synthesized entrypoint
 *  starts the app the same way the compose app would. */
async function inspectStartCommand(sandbox: Sandbox, image: string): Promise<string> {
  for (const field of ["Cmd", "Entrypoint"]) {
    const raw = (
      await run(sandbox, `docker inspect --format='{{json .Config.${field}}}' ${image}`)
    ).result.trim();
    if (raw && raw !== "null") {
      try {
        const parsed = JSON.parse(raw) as string[] | null;
        if (Array.isArray(parsed) && parsed.length > 0) return parsed.join(" ");
      } catch {
        // fall through to the next field
      }
    }
  }
  throw new Error(`app image ${image} declares no CMD or ENTRYPOINT to start it`);
}

/**
 * The one shell line a mesh service starts with, from its image's ENTRYPOINT, CMD and WORKDIR and
 * the compose overrides. Compose semantics: `command` replaces CMD, `entrypoint` replaces ENTRYPOINT,
 * and a set `entrypoint` also drops the image's CMD unless `command` is given. The argv is what the
 * container would exec, so each argument is quoted: the provisioner runs this line with `sh -c`, and
 * `sh -c "until nc -z mongo 27017; do sleep 2; done"` joined bare would split the script into words.
 */
export function meshStartCommand(
  image: { entrypoint: string[]; cmd: string[]; workdir: string },
  compose: { entrypoint?: string[]; command?: string[] } = {},
): string | undefined {
  const entrypoint = compose.entrypoint ?? image.entrypoint;
  const cmd = compose.command ?? (compose.entrypoint !== undefined ? [] : image.cmd);
  const argv = [...entrypoint, ...cmd];
  if (argv.length === 0) return undefined;
  const command = argv.map(shellWord).join(" ");
  // Run the command in the image's WORKDIR: a relative launch (vuln-bank's CMD is "./start.sh") is
  // resolved against it, and the provisioner runs the command from an unrelated directory otherwise.
  return image.workdir && image.workdir !== "/" ? `cd ${shellWord(image.workdir)} && ${command}` : command;
}

/** Quote an argument for sh only when it needs it, so a plain launch line stays readable in the
 *  reviewed manifest ("docker-entrypoint.sh postgres") and host-command checks still see its head. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : shellArg(value);
}

/** Read a built or pulled image's ENTRYPOINT, CMD and WORKDIR and combine them with the service's
 *  compose overrides. The provisioner runs the result after the image's entrypoint was overridden to
 *  idle, so it must be the complete launch line, not just the CMD. */
async function inspectMeshStartCommand(
  sandbox: Sandbox,
  image: string,
  service: { command?: string[]; entrypoint?: string[] },
  runtime: MeshBuildRuntime = liveMeshRuntime,
): Promise<string> {
  const read = async (field: "Entrypoint" | "Cmd"): Promise<string[]> => {
    const raw = (await runtime.run(sandbox, `docker inspect --format='{{json .Config.${field}}}' ${image}`)).result.trim();
    if (!raw || raw === "null") return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  };
  const entrypoint = await read("Entrypoint");
  const cmd = await read("Cmd");
  const workdir = (await runtime.run(sandbox, `docker inspect --format='{{.Config.WorkingDir}}' ${image}`)).result.trim();
  const command = meshStartCommand({ entrypoint, cmd, workdir }, service);
  if (!command) throw new Error(`service image ${image} declares no CMD or ENTRYPOINT to start it`);
  // The provisioner refuses a longer line; fail the build with the reason rather than every verify.
  if (command.length > 1_000) throw new Error(`service image ${image} start command is over 1000 characters`);
  return command;
}

/** Daytona caps the sandbox domain allow-list at this many hosts. */
const MAX_EGRESS_DOMAINS = 20;

function egressAllowList(plan: BuildPlan, imageRegistryHost?: string): string[] {
  // The per-ecosystem code map is the source of truth; the old global BUILD_EGRESS_ALLOWLIST env is
  // deliberately not unioned in, both because it defeats the per-ecosystem narrowing and because the
  // union blew past Daytona's 20-domain cap. A repo that needs an extra host declares it on the plan.
  const hosts = selectEgressHosts({
    ecosystem: plan.ecosystem,
    extraEgressHosts: [...(plan.extraEgressHosts ?? []), ...(imageRegistryHost ? [imageRegistryHost] : [])],
  });
  if (hosts.length > MAX_EGRESS_DOMAINS) {
    throw new Error(
      `build egress needs ${hosts.length} domains, over Daytona's ${MAX_EGRESS_DOMAINS} cap; trim the ${plan.ecosystem} profile or the plan's extra hosts`,
    );
  }
  return hosts;
}

function renderBuildArgs(args: Record<string, string> | undefined): string {
  if (!args) return "";
  return Object.entries(args)
    .map(([k, v]) => `--build-arg ${k}=${shellArg(v)}`)
    .join(" ");
}

function portFromBaseUrl(baseUrl: string | undefined): number {
  if (!baseUrl) throw new Error("compose-synth plan has no runtime baseUrl for the app port");
  const url = new URL(baseUrl);
  // URL.port is empty for a scheme's default port (80 for http, 443 for https), so fall back to it.
  const n = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(n) || n <= 0) throw new Error(`compose-synth baseUrl has no usable port: ${baseUrl}`);
  return n;
}

async function writeGenDockerfile(
  sandbox: Sandbox,
  dockerfile: string,
  runtime: MeshBuildRuntime = liveMeshRuntime,
): Promise<void> {
  // Write via a base64 pipe so an arbitrary Dockerfile (with quotes, newlines) reaches the file
  // intact regardless of shell quoting.
  const b64 = Buffer.from(dockerfile, "utf8").toString("base64");
  await runtime.run(sandbox, `mkdir -p /work/gen && echo ${shellArg(b64)} | base64 -d > /work/gen/Dockerfile`);
}

/**
 * The build's canonical identity. Delegates to sourceIdentityDigest so there is one digest function
 * in the codebase: the same source/repo/plan/service inputs produce the same digest whether they are
 * hashed here or by anything else that records target identity, and unordered service lists can never
 * produce false drift between two builds of the same source.
 */
function buildRecipeDigest(
  plan: BuildPlan,
  buildMarker: string,
  imageDigest: string,
  identity: {
    repoFullName?: string;
    resolvedCommitSha?: string;
    sourceArchiveDigest?: string;
    serviceDigests?: Array<{ service: string; imageDigest: string; snapshotId: string }>;
  } = {},
): string {
  // A git build's marker is the commit, so it doubles as the commit anchor when one was not passed
  // in. A non-git build (archive or prebuilt image) has a marker that is not a commit, so it is left
  // out and the archive or image digest anchors the identity instead.
  const resolvedCommitSha = isCommitSha(identity.resolvedCommitSha)
    ? identity.resolvedCommitSha
    : isCommitSha(buildMarker)
      ? buildMarker
      : undefined;
  return sourceIdentityDigest({
    repoFullName: identity.repoFullName ?? "",
    ...(resolvedCommitSha ? { resolvedCommitSha } : {}),
    ...(identity.sourceArchiveDigest ? { sourceArchiveDigest: identity.sourceArchiveDigest } : {}),
    plan,
    ...(identity.serviceDigests ? { services: identity.serviceDigests } : {}),
    // The app digest and marker are part of identity too, so two builds from the same source that
    // produced different artifacts cannot share a digest.
    imageDigest,
    buildMarker,
  });
}

/** Run a build command and fail loudly on a non-zero exit, keeping the log tail where the failure is. */
async function run(sandbox: Sandbox, command: string): Promise<ExecResult> {
  const result = await execute(sandbox, `sh -lc ${shellArg(command)}`, BUILD_TIMEOUT_S);
  if (result.exitCode !== 0) {
    throw new Error(`build command failed (exit ${result.exitCode}): ${result.result.slice(-2000)}`);
  }
  return result;
}

async function startDockerDaemon(sandbox: Sandbox): Promise<void> {
  await run(
    sandbox,
    "dockerd >/tmp/dockerd.log 2>&1 & for i in $(seq 1 30); do docker version >/dev/null 2>&1 && exit 0; sleep 1; done; echo 'docker daemon did not start' >&2; cat /tmp/dockerd.log >&2; exit 1",
  );
}

/** owner/name -> a registry-safe, collision-free slug, lowercased and whole (alice/api != bob/api). */
export function repoSlug(repoFullName: string): string {
  return repoFullName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Escape a value to sit inside a single-quoted token in a generated Dockerfile RUN line. */
function shArgDockerfile(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

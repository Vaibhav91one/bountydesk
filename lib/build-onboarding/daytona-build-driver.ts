import { createHash } from "node:crypto";

import { requireEnv, requireSecret } from "@/lib/env";
import {
  BUILD_PURPOSE,
  createBuildSandbox,
  createSnapshot,
  DaytonaError,
  deleteSnapshotByName,
  deleteSandbox,
  execute,
  PURPOSE_LABEL,
  type ExecResult,
  type Sandbox,
} from "@/lib/sandbox/daytona";

import type { BuildPlan } from "./build-plan";
import {
  onboardingSnapshotImageRef,
  type BuildDriver,
  type BuildInput,
  type BuildResult,
  type BuiltService,
} from "./build-driver";
import { synthesizeComposeDockerfile } from "./compose-compiler";
import { getDatastoreRecipe, type DatastoreCreds } from "./datastore-recipes";
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
  return dockerfileText.replace(/^([ \t]*FROM[ \t]+[^\n]+)$/gim, `$1\n${PROXY_TRUST_ENV}`);
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
      const plan = input.plan;
      if (plan.strategy === "not-flattenable") {
        throw new Error(`build called for a not-flattenable repo: ${plan.reason}`);
      }

      const baseSnapshot = requireEnv("BUILD_BASE_SNAPSHOT");
      const ghcrNamespace = requireEnv("GHCR_NAMESPACE").replace(/\/+$/, "");
      const pushToken = requireSecret("GHCR_PUSH_TOKEN");
      const allowList = egressAllowList(plan);

      const slug = repoSlug(input.repoFullName);
      const imageName = `${ghcrNamespace}/${slug}`;
      const imageRef = onboardingSnapshotImageRef(imageName);
      // The clone target is the server-held repository name, not any caller-supplied ref, so nothing
      // can redirect the clone to a different repository than this onboarding row is for.
      const cloneUrl = `https://github.com/${input.repoFullName}.git`;

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

      try {
        await run(sandbox, `git clone --depth 1 ${shellArg(cloneUrl)} /work/source`);
        // The resolved commit is both baked into the marker and returned; the reproduction path
        // re-verifies it from inside the booted image. sourceRef is a clone URL, not a commit, so the
        // pin is this resolved HEAD, recorded in the recipe digest below.
        const buildMarker = (await run(sandbox, "cd /work/source && git rev-parse HEAD")).result.trim();

        await startDockerDaemon(sandbox);

        // A mesh builds one image per service and registers one snapshot each, so it owns the whole
        // push-and-register flow rather than the single-image path below.
        if (plan.strategy === "compose-mesh") {
          return await buildMesh(sandbox, plan, { ghcrNamespace, pushToken, slug, buildMarker });
        }

        const { dockerfileText, buildLog } = await buildImage(sandbox, plan, imageRef, buildMarker);

        // Only now introduce the push credential, use it, and remove it, so the untrusted build ran
        // with no reusable token in the sandbox.
        try {
          await run(sandbox, `echo ${shellArg(pushToken)} | docker login ghcr.io -u bountydesk --password-stdin`);
          await run(sandbox, `docker push ${imageRef}`);
        } finally {
          await run(sandbox, "docker logout ghcr.io").catch(() => undefined);
        }
        const digest = (
          await run(sandbox, `docker inspect --format='{{index .RepoDigests 0}}' ${imageRef} | sed 's/.*@//'`)
        ).result.trim();

        // A rebuild of the same target reuses this deterministic name, and Daytona refuses a create
        // that collides with an existing snapshot. Replace the prior one rather than fail on it.
        await deleteSnapshotByName(`onboarding-${slug}`);
        const snapshot = await createSnapshot({
          name: `onboarding-${slug}`,
          image: imageRef,
          cpu: BUILD_CPU,
          memoryGb: BUILD_MEMORY_GB,
          diskGb: BUILD_DISK_GB,
        });

        return {
          imageName,
          imageDigest: digest,
          snapshotId: snapshot.id,
          dockerfileText,
          buildLog,
          buildMarker,
          buildRecipeDigest: buildRecipeDigest(plan, buildMarker, digest),
        };
      } finally {
        await deleteSandbox(sandbox.id).catch(() => undefined);
      }
    },
  };
}

/** Cap on the captured build log kept on the row for download. BuildKit is chatty; the tail is what a
 *  reviewer wants, so keep the last slice rather than the whole thing. */
const BUILD_LOG_CAP = 64_000;

/**
 * Build a compose-mesh: one image per service, one snapshot per service. A service with a build
 * context is built from the repo and pushed to ghcr with the marker baked in; a service that names a
 * stock image is pulled (to capture its digest) and its public tag is registered as a snapshot
 * directly. The returned BuildResult mirrors the app service at the top level so the single-image
 * consumers keep working, and carries every service in `services` for the mesh provisioner.
 */
async function buildMesh(
  sandbox: Sandbox,
  plan: Extract<BuildPlan, { strategy: "compose-mesh" }>,
  ctx: { ghcrNamespace: string; pushToken: string; slug: string; buildMarker: string },
): Promise<BuildResult> {
  const services: BuiltService[] = [];
  let app: BuiltService | undefined;
  let appDockerfileText = "";
  let appBuildLog = "";

  for (const svc of plan.services) {
    const serviceSlug = `${ctx.slug}-${svc.service}`;
    const common = {
      service: svc.service,
      role: svc.role,
      ...(svc.port !== undefined ? { port: svc.port } : {}),
      ...(svc.env ? { env: svc.env } : {}),
      ...(svc.peers ? { peers: svc.peers } : {}),
    };

    if (svc.build) {
      const context = svc.build.context;
      const dockerfile = svc.build.dockerfile ?? "Dockerfile";
      const imageName = `${ctx.ghcrNamespace}/${serviceSlug}`;
      const imageRef = onboardingSnapshotImageRef(imageName);
      const stageTag = `bountydesk-mesh-${svc.service}`;
      // Relax the proxy TLS check for package hosts (see PROXY_TRUST_ENV), then bake the marker,
      // pinned to root because a service Dockerfile may end on a non-root USER, so reproduction can
      // prove which build booted this service. Build from a derived Dockerfile so the customer's
      // file on disk is left untouched.
      const original = (await run(sandbox, `cat /work/source/${context}/${dockerfile}`)).result;
      const dfText =
        injectProxyTrust(original) +
        `\nUSER root\n${ENSURE_PROBE_TOOL}\nRUN mkdir -p /etc && echo ${shArgDockerfile(ctx.buildMarker)} > ${MARKER_PATH}\n`;
      const prepared = Buffer.from(dfText, "utf8").toString("base64");
      await run(sandbox, `echo ${shellArg(prepared)} | base64 -d > /work/source/${context}/Dockerfile.bountydesk`);
      const log = (
        await run(sandbox, `cd /work/source/${context} && docker build -f Dockerfile.bountydesk ${PROXY_BUILD_ARGS} -t ${stageTag} .`)
      ).result;
      // Capture the service's real start command, then rebuild with an idle entrypoint so the image
      // does not auto-start before the provisioner has wired its peers. The provisioner runs this.
      const startCommand = await inspectMeshStartCommand(sandbox, stageTag);
      await writeGenDockerfile(sandbox, `FROM ${stageTag}\nENTRYPOINT ["tail", "-f", "/dev/null"]\nCMD []\n`);
      await run(sandbox, `cd /work/gen && docker build -t ${imageRef} .`);
      const imageDigest = await pushAndDigest(sandbox, imageRef, ctx.pushToken);
      const snapshotId = await registerServiceSnapshot(serviceSlug, imageRef);
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
      const image = svc.image!;
      const imageName = `${ctx.ghcrNamespace}/${serviceSlug}`;
      const imageRef = onboardingSnapshotImageRef(imageName);
      // Derive an image that adds curl (for the egress and readiness probes) so a minimal datastore
      // image still verifies, and push it under our own immutable tag. This also avoids Daytona
      // rejecting a snapshot of a :latest service image. The datastore keeps its own entrypoint, so
      // it still auto-starts, and gets no marker (it is not a build we prove identity for).
      await run(sandbox, `docker pull ${shellArg(image)}`);
      await writeGenDockerfile(sandbox, `FROM ${image}\nUSER root\n${ENSURE_PROBE_TOOL}\n`);
      await run(sandbox, `cd /work/gen && docker build ${PROXY_BUILD_ARGS} -t ${imageRef} .`);
      const imageDigest = await pushAndDigest(sandbox, imageRef, ctx.pushToken);
      const snapshotId = await registerServiceSnapshot(serviceSlug, imageRef);
      services.push({ ...common, imageName, imageDigest, snapshotId, snapshotImageRef: imageRef });
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
    buildRecipeDigest: buildRecipeDigest(plan, ctx.buildMarker, app.imageDigest),
    services,
  };
}

/** Push a built image and read back its pushed digest. The credential is introduced right before the
 *  push and removed right after, so no untrusted build step ran with a reusable token in the sandbox. */
async function pushAndDigest(sandbox: Sandbox, imageRef: string, pushToken: string): Promise<string> {
  try {
    await run(sandbox, `echo ${shellArg(pushToken)} | docker login ghcr.io -u bountydesk --password-stdin`);
    await run(sandbox, `docker push ${imageRef}`);
  } finally {
    await run(sandbox, "docker logout ghcr.io").catch(() => undefined);
  }
  return (
    await run(sandbox, `docker inspect --format='{{index .RepoDigests 0}}' ${imageRef} | sed 's/.*@//'`)
  ).result.trim();
}

/** Register (or replace) a Daytona snapshot for one mesh service under a deterministic name. Daytona's
 *  delete is eventually consistent, so a create right after a delete can still 409 on the name (more
 *  likely with a mesh's several snapshots); delete again and retry a few times before giving up. */
async function registerServiceSnapshot(serviceSlug: string, image: string): Promise<string> {
  const name = `onboarding-${serviceSlug}`;
  // Delete once. Onboarding is single-flight per repo (a leased row), so this name belongs to this
  // build; deleting again on each retry could remove a snapshot another build just created under the
  // same name, so on a 409 we only wait for the delete to propagate and retry the create.
  await deleteSnapshotByName(name);
  for (let attempt = 1; ; attempt++) {
    try {
      const snapshot = await createSnapshot({ name, image, cpu: BUILD_CPU, memoryGb: BUILD_MEMORY_GB, diskGb: BUILD_DISK_GB });
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

/** The full command a mesh service starts with: its entrypoint and its command combined, since a
 *  service may set either or both. The provisioner runs this after the image's entrypoint was
 *  overridden to idle, so it must be the complete launch line, not just the CMD. */
async function inspectMeshStartCommand(sandbox: Sandbox, image: string): Promise<string> {
  const read = async (field: "Entrypoint" | "Cmd"): Promise<string[]> => {
    const raw = (await run(sandbox, `docker inspect --format='{{json .Config.${field}}}' ${image}`)).result.trim();
    if (!raw || raw === "null") return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  };
  const parts = [...(await read("Entrypoint")), ...(await read("Cmd"))];
  if (parts.length === 0) throw new Error(`service image ${image} declares no CMD or ENTRYPOINT to start it`);
  return parts.join(" ");
}

/** Daytona caps the sandbox domain allow-list at this many hosts. */
const MAX_EGRESS_DOMAINS = 20;

function egressAllowList(plan: BuildPlan): string[] {
  // The per-ecosystem code map is the source of truth; the old global BUILD_EGRESS_ALLOWLIST env is
  // deliberately not unioned in, both because it defeats the per-ecosystem narrowing and because the
  // union blew past Daytona's 20-domain cap. A repo that needs an extra host declares it on the plan.
  const hosts = selectEgressHosts({ ecosystem: plan.ecosystem, extraEgressHosts: plan.extraEgressHosts });
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

async function writeGenDockerfile(sandbox: Sandbox, dockerfile: string): Promise<void> {
  // Write via a base64 pipe so an arbitrary Dockerfile (with quotes, newlines) reaches the file
  // intact regardless of shell quoting.
  const b64 = Buffer.from(dockerfile, "utf8").toString("base64");
  await run(sandbox, `mkdir -p /work/gen && echo ${shellArg(b64)} | base64 -d > /work/gen/Dockerfile`);
}

function buildRecipeDigest(plan: BuildPlan, buildMarker: string, imageDigest: string): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({ plan, buildMarker, imageDigest }))
    .digest("hex")}`;
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

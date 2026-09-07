import { createHash } from "node:crypto";

import { requireEnv, requireSecret } from "@/lib/env";
import {
  BUILD_PURPOSE,
  createBuildSandbox,
  createSnapshot,
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
const PROXY_BUILD_ARGS = ["http_proxy", "https_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]
  .map((name) => `--build-arg ${name}`)
  .join(" ");

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
        const dockerfileText = await buildImage(sandbox, plan, imageRef, buildMarker);

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
          buildMarker,
          buildRecipeDigest: buildRecipeDigest(plan, buildMarker, digest),
        };
      } finally {
        await deleteSandbox(sandbox.id).catch(() => undefined);
      }
    },
  };
}

/** Build the one image `imageRef` from the plan's strategy, and return the Dockerfile that built it
 *  (stored durably and offered for download). */
async function buildImage(
  sandbox: Sandbox,
  plan: Extract<BuildPlan, { strategy: "dockerfile" | "image" | "compose-synth" }>,
  imageRef: string,
  buildMarker: string,
): Promise<string> {
  if (plan.strategy === "dockerfile") {
    const dockerfilePath = plan.dockerfilePath;
    const context = plan.buildContext;
    // Append the marker layer to the customer's Dockerfile, pinned to root because a Dockerfile may
    // end on a non-root USER that cannot write /etc; the offline target then runs as root, fine for a
    // test target.
    await run(
      sandbox,
      `printf 'USER root\\nRUN mkdir -p /etc && echo %s > ${MARKER_PATH}\\n' ${shellArg(buildMarker)} >> /work/source/${context}/${dockerfilePath}`,
    );
    const dockerfileText = (await run(sandbox, `cat /work/source/${context}/${dockerfilePath}`)).result;
    const buildArgs = renderBuildArgs(plan.buildArgs);
    await run(
      sandbox,
      `cd /work/source/${context} && docker build -f ${dockerfilePath} ${PROXY_BUILD_ARGS} ${buildArgs} -t ${imageRef} .`,
    );
    return dockerfileText;
  }

  if (plan.strategy === "image") {
    const dockerfile = [
      `FROM ${plan.baseImage}`,
      "USER root",
      `RUN mkdir -p /etc && echo ${shArgDockerfile(buildMarker)} > ${MARKER_PATH}`,
      "",
    ].join("\n");
    await writeGenDockerfile(sandbox, dockerfile);
    await run(sandbox, `cd /work/gen && docker build ${PROXY_BUILD_ARGS} -t ${imageRef} .`);
    return dockerfile;
  }

  // compose-synth: build the app service first, then the synthesized image FROM it.
  const context = plan.appContext ?? ".";
  const appDockerfile = plan.appDockerfile ?? "Dockerfile";
  await run(
    sandbox,
    `cd /work/source/${context} && docker build -f ${appDockerfile} ${PROXY_BUILD_ARGS} -t ${APP_STAGE_TAG} .`,
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
  await run(sandbox, `cd /work/gen && docker build ${PROXY_BUILD_ARGS} -t ${imageRef} .`);
  return dockerfile;
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

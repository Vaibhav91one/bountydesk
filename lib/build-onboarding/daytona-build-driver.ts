import { requireEnv, requireSecret } from "@/lib/env";
import {
  BUILD_PURPOSE,
  createBuildSandbox,
  createSnapshot,
  deleteSandbox,
  execute,
  PURPOSE_LABEL,
  type ExecResult,
  type Sandbox,
} from "@/lib/sandbox/daytona";

import {
  onboardingSnapshotImageRef,
  type BuildDriver,
  type BuildInput,
  type BuildResult,
} from "./build-driver";

/**
 * The one implementation of BuildDriver that touches live infrastructure.
 *
 * It boots a Docker-in-Docker build sandbox with a narrow, server-held egress allow-list, clones
 * the source, builds its Docker image with the source commit baked into the build marker, pushes
 * the image to a ghcr tag, registers a Daytona snapshot from that tag, and tears the build sandbox
 * down. Everything network-facing lives here; the rest of the pipeline never grants egress.
 *
 * Not unit-tested against live Daytona: this is the isolated infra edge. The pipeline's logic is
 * covered against the fake BuildDriver in worker.test.ts; the client-side guards
 * (createBuildSandbox's empty-allow-list refusal, createSnapshot's digest-image refusal) are
 * covered in daytona's own tests.
 *
 * Config, all server-held:
 *   BUILD_BASE_SNAPSHOT   a DinD-capable Daytona snapshot to build inside
 *   BUILD_EGRESS_ALLOWLIST  comma-separated hosts the build may reach (git, base images, registries)
 *   GHCR_PUSH_TOKEN       a token authorised to push to the target ghcr namespace
 *   GHCR_NAMESPACE        e.g. ghcr.io/vaibhav91one
 */
const BUILD_CPU = 2;
const BUILD_MEMORY_GB = 4;
const BUILD_DISK_GB = 20;
const BUILD_TTL_MINUTES = 30;
const BUILD_TIMEOUT_S = 300;

export function createDaytonaBuildDriver(): BuildDriver {
  return {
    async build(input: BuildInput): Promise<BuildResult> {
      const allowList = requireEnv("BUILD_EGRESS_ALLOWLIST")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
      const baseSnapshot = requireEnv("BUILD_BASE_SNAPSHOT");
      const ghcrNamespace = requireEnv("GHCR_NAMESPACE").replace(/\/+$/, "");
      const pushToken = requireSecret("GHCR_PUSH_TOKEN");

      const slug = repoSlug(input.repoFullName);
      const imageName = `${ghcrNamespace}/${slug}`;
      const imageRef = onboardingSnapshotImageRef(imageName);
      // The clone target is derived from the server-held repository name, not from any
      // caller-supplied ref: nothing an operator or another channel passes can redirect the
      // clone to a different repository than the one this onboarding row is for.
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
        // The resolved commit is the build marker the reproduction path re-verifies, so it is
        // both baked into the image and returned, and the two must be the same value.
        const buildMarker = (
          await run(sandbox, "cd /work/source && git rev-parse HEAD")
        ).result.trim();
        // Append the marker layer, exactly as the manual workflow does (see
        // .github/workflows/build-daytona-target.yml).
        await run(
          sandbox,
          `printf 'RUN mkdir -p /etc && echo %s > /etc/bountydesk-build-marker\\n' ${shellArg(buildMarker)} >> /work/source/Dockerfile`,
        );
        const dockerfileText = (
          await run(sandbox, "cat /work/source/Dockerfile")
        ).result;

        // Build first, with no credential in the sandbox: the Dockerfile is the customer's
        // untrusted code and must not run alongside a reusable push token.
        await run(sandbox, `cd /work/source && docker build -t ${imageRef} .`);
        // Only now introduce the push credential, use it, and remove it before anything else
        // runs, so it is present for the push and nothing more.
        try {
          await run(
            sandbox,
            `echo ${shellArg(pushToken)} | docker login ghcr.io -u bountydesk --password-stdin`,
          );
          await run(sandbox, `docker push ${imageRef}`);
        } finally {
          await run(sandbox, "docker logout ghcr.io").catch(() => undefined);
        }
        const digest = (
          await run(
            sandbox,
            `docker inspect --format='{{index .RepoDigests 0}}' ${imageRef} | sed 's/.*@//'`,
          )
        ).result.trim();

        const snapshot = await createSnapshot({
          name: `onboarding-${repoSlug(input.repoFullName)}`,
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
        };
      } finally {
        await deleteSandbox(sandbox.id).catch(() => undefined);
      }
    },
  };
}

/** Run a build command and fail loudly on a non-zero exit: a silent build failure must never
 *  reach snapshot registration. */
async function run(sandbox: Sandbox, command: string): Promise<ExecResult> {
  const result = await execute(sandbox, command, BUILD_TIMEOUT_S);
  if (result.exitCode !== 0) {
    throw new Error(`build command failed (exit ${result.exitCode}): ${result.result.slice(0, 400)}`);
  }
  return result;
}

/**
 * owner/name -> a registry-safe, collision-free slug, lowercased. The whole owner/name is kept,
 * not just the final segment: alice/api and bob/api are different targets and must not share an
 * image tag or a snapshot name.
 */
export function repoSlug(repoFullName: string): string {
  return repoFullName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Single-quote a value for a shell command line. */
function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

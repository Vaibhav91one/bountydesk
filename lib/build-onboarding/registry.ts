import { requireEnv, requireSecret } from "@/lib/env";
import type { ExecResult, Sandbox } from "@/lib/sandbox/daytona";

/**
 * Where a build pushes its image and reads it back, behind one interface so the GHCR wiring is not
 * spread through the build driver. A later ephemeral or private registry (the onboarding follow-ups)
 * replaces this by implementing the same interface, and the driver never changes.
 *
 * The default is GHCR, configured through REGISTRY_HOST/USER/NAMESPACE/PUSH_TOKEN with the historical
 * GHCR_NAMESPACE and GHCR_PUSH_TOKEN as the fallbacks, so an existing deployment keeps working with no
 * new configuration.
 */

/** What a push hands back: the tag a reproduction snapshot pulls, and the image's own digest. */
export type PushedImage = {
  /** The reference the Daytona snapshot registers and boots from. Today it is the same ref that was
   *  pushed; a registry that stores an image under a different pullable name overrides it here. */
  pullableTag: string;
  /** sha256:<64 hex> of the pushed image, read back from the registry. */
  digest: string;
};

/** A command runner inside the build sandbox. It throws on a non-zero exit, so a caller never checks
 *  an exit code. Both the live driver `run` and the mesh test fake satisfy this. */
export type SandboxRun = (sandbox: Sandbox, command: string) => Promise<ExecResult>;

export interface RegistryHandoff {
  /** Registry host and namespace, e.g. "ghcr.io/acme"; an image is named `${namespace}/${slug}`. */
  readonly namespace: string;
  /** Log in, push the locally built and tagged image, read its pushed digest, then log out. */
  push(sandbox: Sandbox, imageRef: string, run: SandboxRun): Promise<PushedImage>;
  /** Delete an image the build pushed, once its snapshot has materialised so it is no longer needed
   *  to boot the target. Best-effort by contract: it reclaims storage, so it never throws. */
  deleteImage(pullableTag: string): Promise<void>;
}

export type RegistryConfig = {
  host: string;
  user: string;
  namespace: string;
  pushToken: string;
  /** A token with permission to delete a package version, when image reclaim is enabled. Absent
   *  leaves pushed images in place after their snapshot materialises. */
  deleteToken?: string;
};

// Config values are operator-set, never report or model input, but a build interpolates the host and
// user into a shell `docker login`, so they are still checked against a safe shape before use.
const HOST_RE = /^[a-z0-9][a-z0-9.-]*(?::\d+)?$/i;
const USER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function createRegistry(config: RegistryConfig): RegistryHandoff {
  const host = config.host.trim();
  const user = config.user.trim();
  const namespace = config.namespace.trim().replace(/\/+$/, "");
  if (!HOST_RE.test(host)) throw new Error(`registry host is not a valid hostname: ${host}`);
  if (!USER_RE.test(user)) throw new Error(`registry user is not a valid login name: ${user}`);
  if (!namespace) throw new Error("registry namespace is required");
  return new EnvRegistry(host, user, namespace, config.pushToken, config.deleteToken);
}

/** The default registry from env. REGISTRY_* wins; the historical GHCR_* values are the fallbacks, so
 *  a deployment that only sets GHCR_NAMESPACE and GHCR_PUSH_TOKEN behaves exactly as before. */
export function resolveRegistry(): RegistryHandoff {
  return createRegistry({
    host: process.env.REGISTRY_HOST?.trim() || "ghcr.io",
    user: process.env.REGISTRY_USER?.trim() || "bountydesk",
    namespace: process.env.REGISTRY_NAMESPACE?.trim() || requireEnv("GHCR_NAMESPACE"),
    pushToken: process.env.REGISTRY_PUSH_TOKEN?.trim() || requireSecret("GHCR_PUSH_TOKEN"),
    deleteToken: process.env.REGISTRY_DELETE_TOKEN?.trim() || undefined,
  });
}

class EnvRegistry implements RegistryHandoff {
  constructor(
    private readonly host: string,
    private readonly user: string,
    readonly namespace: string,
    private readonly pushToken: string,
    private readonly deleteToken?: string,
  ) {}

  async push(sandbox: Sandbox, imageRef: string, run: SandboxRun): Promise<PushedImage> {
    // Introduce the credential right before the push and drop it right after, so no untrusted build
    // step ran with a reusable token in the sandbox.
    try {
      await run(sandbox, `echo ${shArg(this.pushToken)} | docker login ${this.host} -u ${this.user} --password-stdin`);
      await run(sandbox, `docker push ${imageRef}`);
    } finally {
      await run(sandbox, `docker logout ${this.host}`).catch(() => undefined);
    }
    const digest = (
      await run(sandbox, `docker inspect --format='{{index .RepoDigests 0}}' ${imageRef} | sed 's/.*@//'`)
    ).result.trim();
    return { pullableTag: imageRef, digest };
  }

  async deleteImage(pullableTag: string): Promise<void> {
    if (this.host !== "ghcr.io") {
      console.warn(`registry ${this.host} has no image-delete path yet; ${pullableTag} is left in place`);
      return;
    }
    if (!this.deleteToken) {
      // The push token is not delete-scoped. This is the documented default: the snapshot is
      // self-contained once active, so the leftover image is harmless, just unreclaimed.
      console.warn(`origin image ${pullableTag} not deleted: set REGISTRY_DELETE_TOKEN (delete:packages) to reclaim it`);
      return;
    }
    await deleteGhcrImage(pullableTag, this.deleteToken);
  }
}

/** ghcr.io/<owner>/<package...>:<tag> into its parts. The package may contain slashes, which the
 *  GitHub Packages API takes URL-encoded. */
export function parseGhcrRef(pullableTag: string): { owner: string; packageName: string; tag: string } {
  const match = /^ghcr\.io\/([^/]+)\/(.+):([^/:]+)$/.exec(pullableTag);
  if (!match) throw new Error(`not a ghcr.io tagged reference: ${pullableTag}`);
  return { owner: match[1], packageName: match[2], tag: match[3] };
}

export type GhcrPackageVersion = { id: number; metadata?: { container?: { tags?: string[] } } };

/** The version id carrying this tag, or null when none does. A container package holds many versions
 *  keyed by digest; only the one tagged with our onboarding tag is ours to delete. */
export function pickVersionIdByTag(versions: GhcrPackageVersion[], tag: string): number | null {
  for (const version of versions) {
    if (version.metadata?.container?.tags?.includes(tag)) return version.id;
  }
  return null;
}

async function deleteGhcrImage(pullableTag: string, token: string): Promise<void> {
  let ref: { owner: string; packageName: string; tag: string };
  try {
    ref = parseGhcrRef(pullableTag);
  } catch (error) {
    console.warn(`could not parse ${pullableTag} for deletion: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const pkg = encodeURIComponent(ref.packageName);
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "bountydesk-onboarding",
    "x-github-api-version": "2022-11-28",
  };
  // The namespace owner may be an organisation or a user, and the two live under different endpoints,
  // so try the org first and fall through to the user on a 404.
  for (const base of [
    `https://api.github.com/orgs/${ref.owner}/packages/container/${pkg}`,
    `https://api.github.com/users/${ref.owner}/packages/container/${pkg}`,
  ]) {
    const listed = await fetch(`${base}/versions?per_page=100`, { headers, signal: AbortSignal.timeout(15_000) });
    if (listed.status === 404) continue;
    if (!listed.ok) {
      console.warn(`could not list versions of ${pullableTag}: ${listed.status}`);
      return;
    }
    const versions = (await listed.json()) as GhcrPackageVersion[];
    const id = pickVersionIdByTag(versions, ref.tag);
    if (id === null) {
      console.warn(`origin image ${pullableTag} has no version tagged ${ref.tag}; nothing to delete`);
      return;
    }
    const deleted = await fetch(`${base}/versions/${id}`, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!deleted.ok && deleted.status !== 404) {
      console.warn(`could not delete ${pullableTag} (version ${id}): ${deleted.status}`);
    }
    return;
  }
  console.warn(`origin image ${pullableTag} package not found under org or user ${ref.owner}`);
}

function shArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

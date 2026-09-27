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
 * A prebuilt image ref reaches the Daytona API and is stored on the profile, and its untagged name is
 * later compared against a snapshot's imageName. This keeps the reference to the characters a
 * registry reference actually uses so a stray value with a space or a shell metacharacter is refused
 * at the boundary rather than carried downstream. Only the repository half is used: the image is
 * pulled by digest, so the tag itself is never trusted.
 */
const SAFE_IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export function isSafeImageRef(ref: string): boolean {
  return ref.length <= 512 && SAFE_IMAGE_REF.test(ref);
}

/**
 * The registries a prebuilt image may be pulled from.
 *
 * A prebuilt image's registry host is added to the build sandbox's egress allow-list, so whoever
 * names the image decides one host the build can reach. An uploader is a stranger, so that host has
 * to come from a server-held list rather than from the reference they typed. PREBUILT_IMAGE_REGISTRIES
 * is a comma-separated list of hosts; unset, it is Docker Hub and GHCR, which the base allow-list
 * already covers, so the default opens nothing new.
 */
export const DEFAULT_PREBUILT_IMAGE_REGISTRIES = ["docker.io", "ghcr.io"] as const;

export function allowedImageRegistries(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.PREBUILT_IMAGE_REGISTRIES?.trim();
  if (!raw) return [...DEFAULT_PREBUILT_IMAGE_REGISTRIES];
  return raw
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The host a reference pulls from: Docker Hub when it names no registry, null when its first segment
 * names a registry that is not a valid host, so it is refused rather than mistaken for Docker Hub.
 */
export function imageRegistryHost(imageRef: string): string | null {
  const slash = imageRef.indexOf("/");
  const first = slash < 0 ? "" : imageRef.slice(0, slash);
  if (!first.includes(".") && !first.includes(":") && first !== "localhost") return "docker.io";
  return registryHostOf(imageRef) ?? null;
}

/** Null when the image's registry is allowed, otherwise the reason it is refused. */
export function imageRegistryRefusal(imageRef: string, env: Record<string, string | undefined> = process.env): string | null {
  const host = imageRegistryHost(imageRef);
  if (!host) return "the image reference does not name a valid registry host";
  const allowed = allowedImageRegistries(env);
  if (allowed.includes(host)) return null;
  return `images from ${host} are not accepted; allowed registries are ${allowed.join(", ")}`;
}

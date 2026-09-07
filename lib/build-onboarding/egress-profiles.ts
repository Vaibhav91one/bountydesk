import { type Ecosystem } from "./build-plan";

/**
 * The build sandbox reaches only an allowlist of hosts, so the customer's untrusted Dockerfile can
 * fetch its dependencies and nothing else. A single global list forced every build to carry every
 * ecosystem's package hosts, and adding a language meant editing an env string in production. This
 * makes the list a function of the detected ecosystem instead: the base set is always allowed, the
 * ecosystem set is added for the language the repo builds in, and a plan can name a few extra hosts
 * for a repo that fetches from somewhere the ecosystem default does not cover.
 *
 * This is still an allowlist. Selecting per ecosystem narrows what a given build can reach compared
 * to the old union; it never opens egress wider. The reproduction sandbox is untouched and offline.
 */

/** Always allowed: cloning from GitHub, pulling base images from Docker Hub and GHCR, and the Alpine
 *  and Debian package mirrors, because Alpine and Debian-slim are the base OS of a large share of
 *  images regardless of the app's own language (a `node:*-slim` is Debian, so a Node image that
 *  apt-installs one system package needs these too, not just PHP). GitHub release assets
 *  (`objects.githubusercontent.com`) sit here too, since many Dockerfiles download a pinned release
 *  tarball rather than a language package. */
export const BASE_EGRESS: readonly string[] = [
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "ghcr.io",
  "pkg-containers.githubusercontent.com",
  "registry-1.docker.io",
  "auth.docker.io",
  "index.docker.io",
  "docker.io",
  "production.cloudflare.docker.com",
  "production.cloudfront.docker.com",
  "dl-cdn.alpinelinux.org",
  "deb.debian.org",
  "security.debian.org",
];

/** Package hosts per ecosystem, added on top of the base set. `none` is a build that fetches nothing
 *  beyond the base (a prebuilt image, or a Dockerfile with no network RUN steps). */
export const ECOSYSTEM_EGRESS: Record<Ecosystem, readonly string[]> = {
  none: [],
  node: ["registry.npmjs.org"],
  python: ["pypi.org", "files.pythonhosted.org"],
  // Composer and its package index for the PHP base (the Debian apt hosts it also needs are in the
  // base set now). api.github.com and codeload cover Composer resolving VCS dependencies.
  php: [
    "getcomposer.org",
    "repo.packagist.org",
    "packagist.org",
    "api.github.com",
  ],
  // Maven Central, the Gradle plugin portal and distribution, and Adoptium for a pinned JDK/JRE.
  java: [
    "repo.maven.apache.org",
    "repo1.maven.org",
    "plugins.gradle.org",
    "services.gradle.org",
    "api.adoptium.net",
  ],
  ruby: ["rubygems.org", "index.rubygems.org"],
  go: ["proxy.golang.org", "sum.golang.org", "storage.googleapis.com"],
  dotnet: ["api.nuget.org", "dotnetcli.azureedge.net", "dotnetbuilds.azureedge.net"],
};

/**
 * The egress allowlist for one build: the base set, the ecosystem set, and any extra hosts the plan
 * named, de-duplicated and sorted so two equal selections produce the same string (the build-recipe
 * digest hashes this, and Daytona takes it as a comma-joined list). `extraEgressHosts` is validated
 * to bare hostnames in `parseBuildPlan`, so nothing hostile reaches here.
 */
export function selectEgressHosts(input: {
  ecosystem: Ecosystem;
  extraEgressHosts?: readonly string[];
}): string[] {
  const hosts = new Set<string>([
    ...BASE_EGRESS,
    ...ECOSYSTEM_EGRESS[input.ecosystem],
    ...(input.extraEgressHosts ?? []),
  ]);
  return [...hosts].sort();
}

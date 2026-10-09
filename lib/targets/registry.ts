export const JUICE_SHOP_PROFILE_NAME = "juice-shop-v17.3.0";
export const DEFAULT_TARGET_NAME = JUICE_SHOP_PROFILE_NAME;

export type TargetProvisioningConfig = {
  readinessPath: string;
  expectedBuildMarker: string;
  startCommand?: string;
  snapshotImageRefOverride?: string;
  /** Extra seconds the reproduction sandbox waits for readiness beyond the default, for an image
   *  that starts a datastore before the app answers (a bundled MariaDB) or a slow JVM. */
  warmupSeconds?: number;
};

export type TargetPin = {
  imageDigest: string;
  snapshotId: string | null;
  buildMarker?: string;
  snapshotImageRefOverride?: string;
  buildRecipeDigest?: string;
  resolvedCommitSha?: string;
  sourceArchiveDigest?: string;
};

export type TargetDefinition = {
  name: string;
  repoFullName: string;
  envPrefix: string;
  imageName: string;
  config: Record<string, unknown>;
  scopeRules: unknown[];
  provisioning: Omit<TargetProvisioningConfig, "expectedBuildMarker"> & {
    expectedBuildMarker?: string;
  };
};

export const JUICE_SHOP_IMAGE_NAME = "ghcr.io/vaibhav91one/juice-shop";
export const JUICE_SHOP_EXPECTED_BUILD_MARKER =
  "1867b926c5f50e4e692dc9c8f61821413cebe0cd";
export const JUICE_SHOP_TAG_PINNED_SNAPSHOT_IMAGE_REF =
  `${JUICE_SHOP_IMAGE_NAME}:v17.3.0-bountydesk-sandbox`;

export const DVWA_IMAGE_NAME = "ghcr.io/vaibhav91one/dvwa";
// v1.9, the last pre-Dockerization tag and the version this image's command-injection path and
// readiness check were verified against. MariaDB bundled into the same image (a Daytona sandbox
// boots one container, not the fork's own two-container compose.yml); schema and seed data come
// from the app's own setup.php, triggered once at boot by the image's start script.
export const DVWA_EXPECTED_BUILD_MARKER =
  "3cd38c444249e3a016fc203c79ecb68052283f54";
export const DVWA_TAG_PINNED_SNAPSHOT_IMAGE_REF =
  `${DVWA_IMAGE_NAME}:v1.9-bountydesk-sandbox`;

export const WEBGOAT_IMAGE_NAME = "ghcr.io/vaibhav91one/webgoat";
// v2025.3: one self-contained jar with the lessons bundled (embedded Tomcat and HSQLDB), so no
// second lessons repository is needed the way the 7.1 tag required.
export const WEBGOAT_EXPECTED_BUILD_MARKER =
  "c3ed45a733377bc7313b93f57ff518254d81380f";
export const WEBGOAT_TAG_PINNED_SNAPSHOT_IMAGE_REF =
  `${WEBGOAT_IMAGE_NAME}:v2025.3-bountydesk-sandbox`;

/**
 * A build marker only proves provenance once the operator has actually built the image and
 * baked the source commit into it (see lib/sandbox/build-marker.ts). The challenge targets
 * still scaffolded below carry this sentinel instead of a real commit. buildMarkerCheck
 * compares it against what booted inside the sandbox and will refuse to proceed while it is
 * still the sentinel, which is the behaviour we want: nothing reproduces against an unbuilt
 * target. Replace it with the fork's pinned commit when the image is built.
 */
export const PENDING_BUILD_MARKER = "PENDING_OPERATOR_BUILD";

const LOCALHOST_SCOPE = [{ allow: "localhost" }];

const TARGETS: TargetDefinition[] = [
  {
    name: JUICE_SHOP_PROFILE_NAME,
    repoFullName: "Vaibhav91one/juice-shop",
    envPrefix: "JUICE_SHOP_V17_3_0",
    imageName: JUICE_SHOP_IMAGE_NAME,
    config: {
      baseUrl: "http://localhost:3000",
      searchPath: "/rest/products/search",
      canaryRegistrationPath: "/api/Users/",
    },
    scopeRules: LOCALHOST_SCOPE,
    provisioning: {
      readinessPath: "/",
      startCommand:
        "cd /juice-shop && (nohup node build/app >/tmp/bountydesk-app.log 2>&1 &)",
      expectedBuildMarker: JUICE_SHOP_EXPECTED_BUILD_MARKER,
      snapshotImageRefOverride: JUICE_SHOP_TAG_PINNED_SNAPSHOT_IMAGE_REF,
    },
  },
  // DVWA and WebGoat are built (see their *_EXPECTED_BUILD_MARKER); the remaining targets are still
  // scaffolding: config and recipes an operator can build against, not live profiles. imageName
  // is where each fork is expected to be built and pushed, mirroring juice-shop's ghcr path; the
  // upstream public image each fork is based on is recorded in docs/additional-targets.md.
  // imageDigest and snapshotId come from the operator build step and stay unset here on purpose
  // (the seed script reads them from the environment and rejects the env.example placeholders),
  // and expectedBuildMarker is PENDING_BUILD_MARKER until a build bakes a real commit in. baseUrl
  // carries the app's own port, which is what authorize-reproduction turns into the sandbox
  // preview port.
  {
    // DVWA (Damn Vulnerable Web Application), a PHP/MySQL app. Serves on port 80.
    name: "dvwa",
    repoFullName: "Vaibhav91one/DVWA",
    envPrefix: "DVWA",
    imageName: "ghcr.io/vaibhav91one/dvwa",
    config: {
      baseUrl: "http://localhost:80",
      commandInjectionPath: "/vulnerabilities/exec/",
    },
    scopeRules: LOCALHOST_SCOPE,
    provisioning: {
      readinessPath: "/login.php",
      expectedBuildMarker: DVWA_EXPECTED_BUILD_MARKER,
      snapshotImageRefOverride: DVWA_TAG_PINNED_SNAPSHOT_IMAGE_REF,
      // MariaDB inits on first boot (schema plus seed data via setup.php), the Java-app
      // equivalent of what warmupSeconds already exists for: extra time before the readiness
      // probe gives up.
      warmupSeconds: 20,
    },
  },
  {
    // WebGoat, a Java/Spring lesson app. Serves on port 8080 under the /WebGoat context path.
    name: "webgoat",
    repoFullName: "Vaibhav91one/WebGoat",
    envPrefix: "WEBGOAT",
    imageName: "ghcr.io/vaibhav91one/webgoat",
    config: {
      baseUrl: "http://localhost:8080",
      sqlInjectionPath: "/WebGoat/SqlInjection/assignment5a",
    },
    scopeRules: LOCALHOST_SCOPE,
    provisioning: {
      readinessPath: "/WebGoat/login",
      expectedBuildMarker: WEBGOAT_EXPECTED_BUILD_MARKER,
      snapshotImageRefOverride: WEBGOAT_TAG_PINNED_SNAPSHOT_IMAGE_REF,
    },
  },
  {
    // DSVW (Damn Small Vulnerable Web), a single-file Python app. Serves on port 65412.
    name: "dsvw",
    repoFullName: "Vaibhav91one/DSVW",
    envPrefix: "DSVW",
    imageName: "ghcr.io/vaibhav91one/dsvw",
    config: {
      baseUrl: "http://localhost:65412",
      sqlInjectionPath: "/",
    },
    scopeRules: LOCALHOST_SCOPE,
    provisioning: {
      readinessPath: "/",
      expectedBuildMarker: PENDING_BUILD_MARKER,
    },
  },
  {
    // A Log4Shell (CVE-2021-44228) lab, a vulnerable Spring Boot app. Serves on port 8080.
    name: "log4shell-cve-lab",
    repoFullName: "Vaibhav91one/log4shell-cve-lab",
    envPrefix: "LOG4SHELL_CVE_LAB",
    imageName: "ghcr.io/vaibhav91one/log4shell-cve-lab",
    config: {
      baseUrl: "http://localhost:8080",
      injectionPath: "/",
      injectionHeader: "X-Api-Version",
    },
    scopeRules: LOCALHOST_SCOPE,
    provisioning: {
      readinessPath: "/",
      expectedBuildMarker: PENDING_BUILD_MARKER,
    },
  },
];

export const TARGET_REGISTRY = Object.freeze(
  Object.fromEntries(TARGETS.map((target) => [target.name, target])),
) as Readonly<Record<string, TargetDefinition>>;

export function listTargetDefinitions(): readonly TargetDefinition[] {
  return TARGETS;
}

export function targetDefinitionFor(name: string): TargetDefinition | null {
  return TARGET_REGISTRY[name] ?? null;
}

export function envNameForTarget(target: TargetDefinition, suffix: string): string {
  return `BOUNTYDESK_TARGET_${target.envPrefix}_${suffix}`;
}

export function targetProfileConfig(
  target: TargetDefinition,
  pin: Pick<TargetPin, "buildMarker" | "snapshotImageRefOverride"> = {},
): Record<string, unknown> {
  const expectedBuildMarker = pin.buildMarker ?? target.provisioning.expectedBuildMarker;
  if (!expectedBuildMarker) {
    throw new Error(`${target.name} has no expected build marker`);
  }

  return {
    ...target.config,
    provisioning: {
      readinessPath: normalizeReadinessPath(target.provisioning.readinessPath),
      expectedBuildMarker,
      ...(target.provisioning.startCommand
        ? { startCommand: target.provisioning.startCommand }
        : {}),
      ...(typeof target.provisioning.warmupSeconds === "number"
        ? { warmupSeconds: target.provisioning.warmupSeconds }
        : {}),
      ...(pin.snapshotImageRefOverride ?? target.provisioning.snapshotImageRefOverride
        ? {
            snapshotImageRefOverride:
              pin.snapshotImageRefOverride ?? target.provisioning.snapshotImageRefOverride,
          }
        : {}),
    },
  };
}

export function targetProvisioningFromConfig(
  targetName: string,
  config: unknown,
): TargetProvisioningConfig | null {
  const target = targetDefinitionFor(targetName);
  const provisioning =
    typeof config === "object" && config !== null
      ? (config as { provisioning?: unknown }).provisioning
      : undefined;

  if (typeof provisioning === "object" && provisioning !== null) {
    const maybeProvisioning = provisioning as Record<string, unknown>;
    const expectedBuildMarker = maybeProvisioning.expectedBuildMarker;
    if (typeof expectedBuildMarker === "string" && expectedBuildMarker.length > 0) {
      return {
        readinessPath: normalizeReadinessPath(
          typeof maybeProvisioning.readinessPath === "string"
            ? maybeProvisioning.readinessPath
            : target?.provisioning.readinessPath,
        ),
        expectedBuildMarker,
        ...(typeof maybeProvisioning.startCommand === "string" &&
        maybeProvisioning.startCommand.length > 0
          ? { startCommand: maybeProvisioning.startCommand }
          : {}),
        ...(typeof maybeProvisioning.warmupSeconds === "number"
          ? { warmupSeconds: maybeProvisioning.warmupSeconds }
          : {}),
        ...(typeof maybeProvisioning.snapshotImageRefOverride === "string" &&
        maybeProvisioning.snapshotImageRefOverride.length > 0
          ? { snapshotImageRefOverride: maybeProvisioning.snapshotImageRefOverride }
          : {}),
      };
    }
  }

  if (!target?.provisioning.expectedBuildMarker) return null;

  return {
    readinessPath: normalizeReadinessPath(target.provisioning.readinessPath),
    expectedBuildMarker: target.provisioning.expectedBuildMarker,
    ...(target.provisioning.startCommand ? { startCommand: target.provisioning.startCommand } : {}),
    ...(target.provisioning.snapshotImageRefOverride
      ? { snapshotImageRefOverride: target.provisioning.snapshotImageRefOverride }
      : {}),
  };
}

function normalizeReadinessPath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

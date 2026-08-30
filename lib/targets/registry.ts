export const JUICE_SHOP_PROFILE_NAME = "juice-shop-v17.3.0";
export const DEFAULT_TARGET_NAME = JUICE_SHOP_PROFILE_NAME;

export type TargetProvisioningConfig = {
  readinessPath: string;
  expectedBuildMarker: string;
  startCommand?: string;
  snapshotImageRefOverride?: string;
};

export type TargetPin = {
  imageDigest: string;
  snapshotId: string | null;
  buildMarker?: string;
  snapshotImageRefOverride?: string;
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
  {
    name: "webgoat",
    repoFullName: "Vaibhav91one/WebGoat",
    envPrefix: "WEBGOAT",
    imageName: "ghcr.io/vaibhav91one/webgoat",
    config: { baseUrl: "http://localhost:8080", readinessPath: "/WebGoat" },
    scopeRules: LOCALHOST_SCOPE,
    provisioning: { readinessPath: "/WebGoat" },
  },
  {
    name: "dvwa",
    repoFullName: "Vaibhav91one/DVWA",
    envPrefix: "DVWA",
    imageName: "ghcr.io/vaibhav91one/dvwa",
    config: { baseUrl: "http://localhost:80", readinessPath: "/" },
    scopeRules: LOCALHOST_SCOPE,
    provisioning: { readinessPath: "/" },
  },
  {
    name: "vampi",
    repoFullName: "Vaibhav91one/VAmPI",
    envPrefix: "VAMPI",
    imageName: "ghcr.io/vaibhav91one/vampi",
    config: { baseUrl: "http://localhost:5000", readinessPath: "/" },
    scopeRules: LOCALHOST_SCOPE,
    provisioning: { readinessPath: "/" },
  },
  {
    name: "dsvw",
    repoFullName: "Vaibhav91one/DSVW",
    envPrefix: "DSVW",
    imageName: "ghcr.io/vaibhav91one/dsvw",
    config: { baseUrl: "http://localhost:8000", readinessPath: "/" },
    scopeRules: LOCALHOST_SCOPE,
    provisioning: { readinessPath: "/" },
  },
  {
    name: "apache-cve-lab",
    repoFullName: "Vaibhav91one/apache-cve-lab",
    envPrefix: "APACHE_CVE_LAB",
    imageName: "ghcr.io/vaibhav91one/apache-cve-lab",
    config: { baseUrl: "http://localhost:80", readinessPath: "/" },
    scopeRules: LOCALHOST_SCOPE,
    provisioning: {
      readinessPath: "/",
      startCommand: "(nohup httpd-foreground >/tmp/bountydesk-app.log 2>&1 &)",
    },
  },
  {
    name: "spring4shell-cve-lab",
    repoFullName: "Vaibhav91one/spring4shell-cve-lab",
    envPrefix: "SPRING4SHELL_CVE_LAB",
    imageName: "ghcr.io/vaibhav91one/spring4shell-cve-lab",
    config: { baseUrl: "http://localhost:8080", readinessPath: "/greeting" },
    scopeRules: LOCALHOST_SCOPE,
    provisioning: {
      readinessPath: "/greeting",
      startCommand: "(nohup catalina.sh run >/tmp/bountydesk-app.log 2>&1 &)",
    },
  },
  {
    name: "nextjs-cve-lab",
    repoFullName: "Vaibhav91one/nextjs-cve-lab",
    envPrefix: "NEXTJS_CVE_LAB",
    imageName: "ghcr.io/vaibhav91one/nextjs-cve-lab",
    config: { baseUrl: "http://localhost:3000", readinessPath: "/" },
    scopeRules: LOCALHOST_SCOPE,
    provisioning: {
      readinessPath: "/",
      startCommand: "cd /app && (nohup npm start >/tmp/bountydesk-app.log 2>&1 &)",
    },
  },
  {
    name: "confluence-cve-lab",
    repoFullName: "Vaibhav91one/confluence-cve-lab",
    envPrefix: "CONFLUENCE_CVE_LAB",
    imageName: "ghcr.io/vaibhav91one/confluence-cve-lab",
    config: { baseUrl: "http://localhost:8090", readinessPath: "/" },
    scopeRules: LOCALHOST_SCOPE,
    provisioning: { readinessPath: "/" },
  },
  {
    name: "teamcity-cve-lab",
    repoFullName: "Vaibhav91one/teamcity-cve-lab",
    envPrefix: "TEAMCITY_CVE_LAB",
    imageName: "ghcr.io/vaibhav91one/teamcity-cve-lab",
    config: { baseUrl: "http://localhost:8111", readinessPath: "/" },
    scopeRules: LOCALHOST_SCOPE,
    provisioning: { readinessPath: "/" },
  },
  {
    name: "log4shell-cve-lab",
    repoFullName: "Vaibhav91one/log4shell-cve-lab",
    envPrefix: "LOG4SHELL_CVE_LAB",
    imageName: "ghcr.io/vaibhav91one/log4shell-cve-lab",
    config: { baseUrl: "http://localhost:8080", readinessPath: "/" },
    scopeRules: LOCALHOST_SCOPE,
    provisioning: { readinessPath: "/" },
  },
  {
    name: "shellshock-cve-lab",
    repoFullName: "Vaibhav91one/shellshock-cve-lab",
    envPrefix: "SHELLSHOCK_CVE_LAB",
    imageName: "ghcr.io/vaibhav91one/shellshock-cve-lab",
    config: { baseUrl: "http://localhost:8080", readinessPath: "/cgi-bin/hello" },
    scopeRules: LOCALHOST_SCOPE,
    provisioning: {
      readinessPath: "/cgi-bin/hello",
      startCommand:
        "cd /opt/lab && (nohup python3 /opt/lab/cgi_server.py >/tmp/bountydesk-app.log 2>&1 &)",
    },
  },
  {
    name: "drupalgeddon2-cve-lab",
    repoFullName: "Vaibhav91one/drupalgeddon2-cve-lab",
    envPrefix: "DRUPALGEDDON2_CVE_LAB",
    imageName: "ghcr.io/vaibhav91one/drupalgeddon2-cve-lab",
    config: { baseUrl: "http://localhost:8080", readinessPath: "/" },
    scopeRules: LOCALHOST_SCOPE,
    provisioning: {
      readinessPath: "/",
      startCommand:
        '(nohup sh -c "php /opt/lab/install.php && php -S 0.0.0.0:8080 -t /opt/lab/drupal /opt/lab/router.php" >/tmp/bountydesk-app.log 2>&1 &)',
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

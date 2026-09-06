/**
 * The build plan is what the onboarding classifier decides before a build runs, and what the build
 * driver consumes to produce exactly one image. It exists because today the build step is fixed
 * (clone, `docker build` the root Dockerfile) and the manifest is only proposed afterwards, so there
 * is nowhere to record "this is a PHP app, build it from a subdir, it needs a MariaDB baked in and
 * seeded at /setup.php". The plan is that record: one classified strategy plus the inputs that
 * strategy needs, plus the runtime shape (port, readiness, start command) the reproduction sandbox
 * will boot.
 *
 * A plan never widens the security model. Every strategy here still emits one image the offline
 * reproduction sandbox boots; `not-flattenable` is the honest exit when no single offline image can
 * represent the repo, and it carries a reason a human reads rather than a silent failure.
 */

/** The build systems we can select a dependency-egress allowlist for. `none` is a repo that fetches
 *  nothing at build (a prebuilt image, or a Dockerfile with no network RUN steps). */
export const ECOSYSTEMS = [
  "none",
  "node",
  "python",
  "php",
  "java",
  "ruby",
  "go",
  "dotnet",
] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

/** Datastores the compose compiler knows how to install into the app image and seed at build. A
 *  compose service whose image is none of these makes the repo `not-flattenable`. */
export const DATASTORE_ENGINES = ["mariadb", "mysql", "postgres", "redis"] as const;
export type DatastoreEngine = (typeof DATASTORE_ENGINES)[number];

export const BUILD_STRATEGIES = [
  "dockerfile",
  "image",
  "compose-synth",
  "not-flattenable",
] as const;
export type BuildStrategy = (typeof BUILD_STRATEGIES)[number];

/**
 * How the datastore gets its schema and data before the reproduction sandbox goes offline. The
 * whole point is determinism: the data is baked into the image at build time, not created on first
 * boot or by a human clicking a button, so every fresh sandbox starts from the same state and the
 * canary oracle stays reproducible.
 * - `none`: the app seeds itself on boot (Juice Shop's model), nothing to do at build.
 * - `http`: after the stack is up at build, GET/POST this same-origin path to trigger the app's own
 *   setup (DVWA's `/setup.php`).
 * - `command`: run this command in the build container to migrate/seed (e.g. a framework's migrate).
 */
export type SeedStep =
  | { kind: "none" }
  | { kind: "http"; method: "GET" | "POST"; path: string }
  | { kind: "command"; command: string };

/** One datastore service pulled out of a compose file, mapped to an engine we can install. The
 *  credentials come from the compose service's own environment so the synthesized app config keeps
 *  matching what the app expects. */
export type ComposeDatastore = {
  service: string;
  engine: DatastoreEngine;
  dbName?: string;
  user?: string;
  password?: string;
};

/** The runtime shape the reproduction sandbox needs, independent of how the image was built. This is
 *  the subset of the target manifest the plan can decide up front from the source; `imageName`,
 *  digest and snapshot are filled by the build, not here. */
export type RuntimeShape = {
  /** The target profile name, lowercase and derived from the repo (DVWA becomes "dvwa"). */
  name: string;
  /** Loopback base URL; the port lives here, matching the manifest's single source of the port. */
  baseUrl: string;
  readinessPath: string;
  startCommand?: string;
  /** Extra seconds to wait for readiness beyond the default, for images that start a datastore
   *  before the app (a cold MariaDB) or a slow JVM. */
  warmupSeconds?: number;
  envPrefix?: string;
  scopeRules?: unknown[];
};

type BuildInputs =
  | {
      strategy: "dockerfile";
      /** Repo-relative path to the Dockerfile, root is "Dockerfile". */
      dockerfilePath: string;
      /** Repo-relative build context directory, root is ".". */
      buildContext: string;
      /** Non-secret build args passed to `docker build`. Never credentials: the build sandbox runs
       *  untrusted code and holds no push token until after the build. */
      buildArgs?: Record<string, string>;
    }
  | {
      strategy: "image";
      /** A published image reference the target is `FROM`; pinned to a digest at build time. */
      baseImage: string;
    }
  | {
      strategy: "compose-synth";
      composePath: string;
      /** The one service that serves HTTP; its build/image becomes the base of the synthesized image. */
      appService: string;
      datastores: ComposeDatastore[];
      /** The app service's build context and Dockerfile from the compose file, so the driver builds
       *  the app image first and the synthesized image is FROM it. Default context ".", Dockerfile. */
      appContext?: string;
      appDockerfile?: string;
      /** Literal file rewrites so a config that names the compose datastore service reaches 127.0.0.1
       *  instead (DVWA's config.inc.php). Env-based apps use envOverrides and need none of these. */
      configRewrites?: Array<{ file: string; from: string; to: string }>;
      /** Environment values to set in the synthesized image, e.g. a DB host env the app reads, set to
       *  127.0.0.1 so the app reaches the bundled datastore on loopback. */
      envOverrides?: Record<string, string>;
    }
  | {
      strategy: "not-flattenable";
      /** Why no single offline image can represent this repo, shown to the reviewer. */
      reason: string;
    };

export type BuildPlan = BuildInputs & {
  ecosystem: Ecosystem;
  /** Hosts to add to the ecosystem's egress allowlist for this specific repo, when it fetches from
   *  somewhere the ecosystem default does not cover. Still an allowlist, never opens egress wide. */
  extraEgressHosts?: string[];
  /** Absent for `not-flattenable`; present for every buildable strategy. */
  seed?: SeedStep;
  /** Absent for `not-flattenable`; the runtime shape the built image boots into. */
  runtime?: RuntimeShape;
};

const PATH_SEGMENT_RE = /^[A-Za-z0-9._/-]+$/;
const BUILD_ARG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_PREFIX_RE = /^[A-Z0-9_]{1,80}$/;
const MAX_WARMUP_SECONDS = 600;

/**
 * Validate an untrusted object (the classifier agent's JSON, or a stored row) into a BuildPlan.
 * Throws with a specific message rather than returning a partial plan: a plan that is wrong in a
 * field the build driver trusts is a build that fails deep in a sandbox, so the seam to catch it is
 * here. Mirrors the field-by-field reading in `lib/targets/manifest.ts`.
 */
export function parseBuildPlan(input: unknown): BuildPlan {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("build plan must be a JSON object");
  }
  const plan = input as Record<string, unknown>;

  const strategy = str(plan, "strategy") as BuildStrategy;
  if (!BUILD_STRATEGIES.includes(strategy)) {
    throw new Error(`build plan strategy must be one of ${BUILD_STRATEGIES.join(", ")}`);
  }

  const ecosystem = str(plan, "ecosystem") as Ecosystem;
  if (!ECOSYSTEMS.includes(ecosystem)) {
    throw new Error(`build plan ecosystem must be one of ${ECOSYSTEMS.join(", ")}`);
  }

  const extraEgressHosts = readHosts(plan.extraEgressHosts);

  if (strategy === "not-flattenable") {
    return { strategy, ecosystem, reason: str(plan, "reason"), ...withHosts(extraEgressHosts) };
  }

  const seed = parseSeed(plan.seed);
  const runtime = parseRuntime(plan.runtime);

  if (strategy === "dockerfile") {
    return {
      strategy,
      ecosystem,
      dockerfilePath: relPath(optStr(plan, "dockerfilePath") ?? "Dockerfile", "dockerfilePath"),
      buildContext: relPath(optStr(plan, "buildContext") ?? ".", "buildContext"),
      ...(plan.buildArgs !== undefined ? { buildArgs: parseBuildArgs(plan.buildArgs) } : {}),
      seed,
      runtime,
      ...withHosts(extraEgressHosts),
    };
  }

  if (strategy === "image") {
    const baseImage = str(plan, "baseImage");
    if (/\s/.test(baseImage) || baseImage.includes("://")) {
      throw new Error("build plan baseImage must be a bare image reference");
    }
    return { strategy, ecosystem, baseImage, seed, runtime, ...withHosts(extraEgressHosts) };
  }

  // compose-synth
  const composePath = relPath(str(plan, "composePath"), "composePath");
  const appService = serviceName(str(plan, "appService"), "appService");
  const datastores = parseDatastores(plan.datastores);
  const appContext = optStr(plan, "appContext");
  const appDockerfile = optStr(plan, "appDockerfile");
  return {
    strategy,
    ecosystem,
    composePath,
    appService,
    datastores,
    ...(appContext ? { appContext: relPath(appContext, "appContext") } : {}),
    ...(appDockerfile ? { appDockerfile: relPath(appDockerfile, "appDockerfile") } : {}),
    ...(plan.configRewrites !== undefined ? { configRewrites: parseRewrites(plan.configRewrites) } : {}),
    ...(plan.envOverrides !== undefined ? { envOverrides: parseBuildArgs(plan.envOverrides) } : {}),
    seed,
    runtime,
    ...withHosts(extraEgressHosts),
  };
}

function parseRewrites(input: unknown): Array<{ file: string; from: string; to: string }> {
  if (!Array.isArray(input)) throw new Error("build plan configRewrites must be an array");
  return input.map((raw, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`build plan configRewrites[${i}] must be an object`);
    }
    const r = raw as Record<string, unknown>;
    return {
      file: containerPath(str(r, "file"), `configRewrites[${i}].file`),
      from: singleLine(str(r, "from"), `configRewrites[${i}].from`),
      to: singleLine(str(r, "to"), `configRewrites[${i}].to`),
    };
  });
}

function parseRuntime(input: unknown): RuntimeShape {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("build plan runtime must be an object for a buildable strategy");
  }
  const runtime = input as Record<string, unknown>;

  const name = str(runtime, "name");
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error("build plan runtime name must be lowercase letters, numbers, dot, dash or underscore");
  }
  const baseUrl = str(runtime, "baseUrl");
  validateLocalHttpBaseUrl(baseUrl);
  const readinessPath = normalizePath(str(runtime, "readinessPath"), "readinessPath");
  const startCommand = optStr(runtime, "startCommand");
  if (startCommand !== undefined) validateStartCommand(startCommand);

  const warmupSeconds = runtime.warmupSeconds;
  if (warmupSeconds !== undefined) {
    if (
      typeof warmupSeconds !== "number" ||
      !Number.isInteger(warmupSeconds) ||
      warmupSeconds < 0 ||
      warmupSeconds > MAX_WARMUP_SECONDS
    ) {
      throw new Error(`build plan runtime warmupSeconds must be an integer 0..${MAX_WARMUP_SECONDS}`);
    }
  }

  const envPrefix = optStr(runtime, "envPrefix");
  if (envPrefix !== undefined && !ENV_PREFIX_RE.test(envPrefix)) {
    throw new Error("build plan runtime envPrefix must use uppercase letters, numbers or underscores");
  }

  const scopeRules = runtime.scopeRules;
  if (scopeRules !== undefined) validateScopeRules(scopeRules);

  return {
    name,
    baseUrl,
    readinessPath,
    ...(startCommand ? { startCommand } : {}),
    ...(warmupSeconds !== undefined ? { warmupSeconds } : {}),
    ...(envPrefix ? { envPrefix } : {}),
    ...(scopeRules !== undefined ? { scopeRules: scopeRules as unknown[] } : {}),
  };
}

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;

/**
 * Build the flat manifest object the driver-produced image needs, from the plan's runtime shape.
 * The plan decided the runtime up front from the source; the image name only exists after the build,
 * so it is supplied here. The result is fed to `parseTargetManifest`, which is the one validator that
 * turns a manifest into a stored target definition, so the plan and the manifest cannot disagree.
 */
export function planToManifest(
  plan: BuildPlan,
  context: { repoFullName: string; imageName: string },
): Record<string, unknown> {
  if (!plan.runtime) throw new Error("build plan has no runtime shape to derive a manifest from");
  const r = plan.runtime;
  return {
    name: r.name,
    repoFullName: context.repoFullName,
    imageName: context.imageName,
    baseUrl: r.baseUrl,
    readinessPath: r.readinessPath,
    ...(r.startCommand ? { startCommand: r.startCommand } : {}),
    ...(r.warmupSeconds !== undefined ? { warmupSeconds: r.warmupSeconds } : {}),
    ...(r.envPrefix ? { envPrefix: r.envPrefix } : {}),
    ...(r.scopeRules ? { scopeRules: r.scopeRules } : {}),
  };
}

function parseSeed(input: unknown): SeedStep {
  if (input === undefined) return { kind: "none" };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("build plan seed must be an object");
  }
  const seed = input as Record<string, unknown>;
  const kind = str(seed, "kind");
  if (kind === "none") return { kind: "none" };
  if (kind === "http") {
    const method = str(seed, "method");
    if (method !== "GET" && method !== "POST") {
      throw new Error("build plan seed http method must be GET or POST");
    }
    return { kind: "http", method, path: normalizePath(str(seed, "path"), "seed.path") };
  }
  if (kind === "command") return { kind: "command", command: singleLine(str(seed, "command"), "seed.command") };
  throw new Error("build plan seed kind must be none, http or command");
}

function parseDatastores(input: unknown): ComposeDatastore[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("build plan compose-synth requires a nonempty datastores array");
  }
  return input.map((raw, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`build plan datastores[${i}] must be an object`);
    }
    const ds = raw as Record<string, unknown>;
    const engine = str(ds, "engine");
    if (!DATASTORE_ENGINES.includes(engine as DatastoreEngine)) {
      throw new Error(`build plan datastores[${i}].engine must be one of ${DATASTORE_ENGINES.join(", ")}`);
    }
    return {
      service: serviceName(str(ds, "service"), `datastores[${i}].service`),
      engine: engine as DatastoreEngine,
      ...(optStr(ds, "dbName") ? { dbName: optStr(ds, "dbName") } : {}),
      ...(optStr(ds, "user") ? { user: optStr(ds, "user") } : {}),
      ...(optStr(ds, "password") !== undefined ? { password: optStr(ds, "password") } : {}),
    };
  });
}

function parseBuildArgs(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("build plan buildArgs must be an object of string values");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!BUILD_ARG_KEY_RE.test(key)) throw new Error(`build plan buildArgs key ${key} is not a valid env name`);
    if (typeof value !== "string" || /[\r\n]/.test(value)) {
      throw new Error(`build plan buildArgs.${key} must be a single-line string`);
    }
    out[key] = value;
  }
  return out;
}

function readHosts(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("build plan extraEgressHosts must be an array of hostnames");
  return input.map((h) => {
    if (typeof h !== "string" || !/^[a-z0-9.-]+$/.test(h)) {
      throw new Error("build plan extraEgressHosts entries must be bare hostnames");
    }
    return h;
  });
}

function withHosts(hosts: string[]): { extraEgressHosts?: string[] } {
  return hosts.length ? { extraEgressHosts: hosts } : {};
}

// Path and name helpers reject traversal and shell-hostile input, since these values flow into build
// commands run inside the sandbox.
function relPath(value: string, key: string): string {
  if (!PATH_SEGMENT_RE.test(value) || value.startsWith("/") || value.includes("..")) {
    throw new Error(`build plan ${key} must be a repo-relative path with no traversal`);
  }
  return value;
}

/** An absolute or relative path inside the built container (a config file to rewrite). Rejects
 *  traversal and shell-hostile characters, since it flows into a build command. */
function containerPath(value: string, key: string): string {
  if (!/^\/?[A-Za-z0-9._/-]+$/.test(value) || value.includes("..")) {
    throw new Error(`build plan ${key} must be a plain container path with no traversal`);
  }
  return value;
}

function serviceName(value: string, key: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`build plan ${key} must be a compose service name`);
  }
  return value;
}

function singleLine(value: string, key: string): string {
  if (/[\r\n]/.test(value) || value.length > 1_000) {
    throw new Error(`build plan ${key} must be a single line under 1000 characters`);
  }
  return value;
}

function str(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`build plan ${key} must be a nonempty string`);
  }
  return value;
}

function optStr(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`build plan ${key} must be a nonempty string when present`);
  }
  return value;
}

// The three checks below match lib/targets/manifest.ts exactly, so a runtime shape that passes here
// also passes when the manifest is finalized after the build. Kept as local copies rather than
// exported from manifest.ts to avoid widening that module's surface; if they drift, a runtime that
// the plan accepted would be rejected at configure time, which the plan-vs-manifest test guards.
function validateLocalHttpBaseUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("build plan runtime baseUrl must be a valid URL");
  }
  if (parsed.protocol !== "http:") throw new Error("build plan runtime baseUrl must use http");
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("build plan runtime baseUrl must point at loopback");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("build plan runtime baseUrl must not include credentials, query or fragment");
  }
}

function normalizePath(value: string, key: string): string {
  if (!value.startsWith("/") || value.includes("://") || /[\r\n]/.test(value)) {
    throw new Error(`build plan ${key} must be a same-origin absolute path`);
  }
  return value;
}

function validateStartCommand(value: string): void {
  if (value.length > 1_000 || /[\r\n]/.test(value)) {
    throw new Error("build plan runtime startCommand must be a single line under 1000 characters");
  }
  const head = (value.trim().split(/\s+/, 1)[0] ?? "").split("/").pop()?.toLowerCase() ?? "";
  if (/^(docker|docker-compose|podman|nerdctl)$/.test(head)) {
    throw new Error(
      "build plan runtime startCommand must launch the app inside the container, not a docker or podman host command",
    );
  }
}

function validateScopeRules(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("build plan runtime scopeRules must be a nonempty array");
  }
  for (const rule of value) {
    if (
      typeof rule !== "object" ||
      rule === null ||
      Array.isArray(rule) ||
      (rule as { allow?: unknown }).allow !== "localhost"
    ) {
      throw new Error("build plan runtime scopeRules may only allow localhost today");
    }
  }
}

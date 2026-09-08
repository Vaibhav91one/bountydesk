import path from "node:path";

import yaml from "js-yaml";

import {
  type BuildPlan,
  type ComposeDatastore,
  type ComposeMeshService,
  type DatastoreEngine,
  type Ecosystem,
} from "./build-plan";
import { getDatastoreRecipe, hasDatastoreRecipe } from "./datastore-recipes";

/**
 * Decide how a repo becomes one offline image before the build runs. The classifier reads a handful
 * of source files (a Dockerfile, a compose file, the language's package manifest) and produces a
 * build plan naming a strategy, or `not-flattenable` with a reason a reviewer reads. It is
 * deterministic on purpose: the same repo classifies the same way every time, and the two shapes we
 * onboard today (a self-contained Dockerfile like DSVW, and an app-plus-datastore compose like DVWA)
 * are decided from the files without a model in the loop. A model refinement pass can fill a runtime
 * detail it cannot infer later; it is not needed to get these two shapes right.
 */

/** Reads files from the target repo at the pinned ref. Abstracted so the worker backs it with the
 *  GitHub contents API and tests back it with a fixed map. `readFile` returns null for a missing
 *  file. */
export type SourceReader = {
  readFile(path: string): Promise<string | null>;
};

const COMPOSE_PATHS = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
  // Common deployment layouts keep the Compose file below the repository root. The source reader
  // is intentionally read-only and has no directory-listing authority, so support reviewed
  // conventional paths explicitly rather than guessing from repo content.
  "deploy/docker/compose.yaml",
  "deploy/docker/compose.yml",
  "deploy/docker/docker-compose.yaml",
  "deploy/docker/docker-compose.yml",
  "docker/compose.yaml",
  "docker/compose.yml",
  "docker/docker-compose.yaml",
  "docker/docker-compose.yml",
];

const ECOSYSTEM_MARKERS: Array<{ file: string; ecosystem: Ecosystem }> = [
  { file: "package.json", ecosystem: "node" },
  { file: "requirements.txt", ecosystem: "python" },
  { file: "pyproject.toml", ecosystem: "python" },
  { file: "composer.json", ecosystem: "php" },
  { file: "pom.xml", ecosystem: "java" },
  { file: "build.gradle", ecosystem: "java" },
  { file: "go.mod", ecosystem: "go" },
  { file: "Gemfile", ecosystem: "ruby" },
];

/** Map a compose service image to a datastore engine we can bundle, or undefined if it is not one. */
function resolveComposeImage(image: string): string | undefined {
  const resolved = image.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)[:-][^}]*\}/g, "latest");
  if (/\$\{[^}]+\}/.test(resolved)) return undefined;
  return resolved;
}

function engineForImage(image: string): DatastoreEngine | undefined {
  const name = image.toLowerCase();
  if (name.includes("mariadb")) return "mariadb";
  if (name.includes("mysql") || name.includes("percona")) return "mysql";
  if (name.includes("postgres")) return "postgres";
  if (name.includes("redis")) return "redis";
  return undefined;
}

export async function detectEcosystem(source: SourceReader): Promise<Ecosystem> {
  for (const marker of ECOSYSTEM_MARKERS) {
    if ((await source.readFile(marker.file)) !== null) return marker.ecosystem;
  }
  return "none";
}

/**
 * Infer the ecosystem from a Dockerfile's base image, for a compose app whose language manifest
 * lives in a subdirectory the root scan misses (DVWA's `composer.json` is under vulnerabilities/api,
 * so only the `FROM php:...` reveals it is PHP). The base image is what decides which package hosts
 * the build needs: a `php`/`composer` base wants Debian apt and Packagist, a `node` base wants npm.
 */
export function ecosystemFromDockerfile(dockerfileText: string): Ecosystem {
  const from = dockerfileText.match(/^\s*FROM\s+(\S+)/im)?.[1]?.toLowerCase() ?? "";
  const image = from.split("/").pop() ?? from; // strip a registry/namespace prefix
  if (/(^|[:@-])php|composer/.test(image) || image.startsWith("php")) return "php";
  if (image.startsWith("node") || image.includes("nodejs")) return "node";
  if (image.startsWith("python") || image.startsWith("pypy")) return "python";
  if (image.startsWith("ruby")) return "ruby";
  if (image.startsWith("golang") || image === "go") return "go";
  if (/openjdk|eclipse-temurin|amazoncorretto|maven|gradle|jdk|jre/.test(image)) return "java";
  if (/dotnet|aspnet/.test(image)) return "dotnet";
  return "none";
}

type ComposeService = {
  image?: string;
  build?: unknown;
  ports?: unknown;
  expose?: unknown;
  environment?: unknown;
  command?: unknown;
  depends_on?: unknown;
  volumes?: unknown;
};

/** A service that mounts the host Docker socket is infrastructure that manages other containers (an
 *  autoheal or watchtower sidecar), not part of the application under test. It has no place in an
 *  offline reproduction sandbox (there is no Docker daemon to reach) and Daytona would reject a
 *  snapshot of a :latest sidecar image, so the mesh drops it. */
const DOCKER_SOCKET = "/var/run/docker.sock";

function mountsDockerSocket(svc: ComposeService): boolean {
  if (!Array.isArray(svc.volumes)) return false;
  return svc.volumes.some((entry) => {
    // Short syntax is "source:target[:mode]"; match the socket as a whole path (source or target),
    // not a substring, so a path that merely contains the text (a "docker.sock.d" dir) is not caught.
    if (typeof entry === "string") return entry.split(":").some((segment) => segment === DOCKER_SOCKET);
    if (entry && typeof entry === "object") {
      const { source, target } = entry as { source?: unknown; target?: unknown };
      return source === DOCKER_SOCKET || target === DOCKER_SOCKET;
    }
    return false;
  });
}

export type ComposeTopology =
  | {
      ok: true;
      appService: string;
      appPort: number;
      datastores: ComposeDatastore[];
      appContext: string;
      appDockerfile: string;
      /** Env keys whose value named a datastore service, remapped to 127.0.0.1 so the app reaches
       *  the bundled datastore on loopback. Empty for an app that hardcodes the host in a file. */
      envOverrides: Record<string, string>;
    }
  | { ok: false; reason: string };

/**
 * Read a compose file into the shape the compiler can flatten: exactly one app service (the one that
 * serves HTTP, identified by an exposed port or a build context) and one or more datastores from an
 * engine we have a recipe for. Anything else is a reason the repo is not-flattenable, not a guess.
 */
export function parseComposeTopology(composeText: string): ComposeTopology {
  let doc: unknown;
  try {
    doc = yaml.load(composeText);
  } catch {
    return { ok: false, reason: "compose file is not valid YAML" };
  }
  const services = (doc as { services?: Record<string, ComposeService> } | null)?.services;
  if (!services || typeof services !== "object") {
    return { ok: false, reason: "compose file declares no services" };
  }

  const datastores: ComposeDatastore[] = [];
  const appCandidates: Array<{ name: string; port: number; svc: ComposeService }> = [];
  for (const [name, svc] of Object.entries(services)) {
    const engine = typeof svc.image === "string" ? engineForImage(svc.image) : undefined;
    if (engine) {
      if (!hasDatastoreRecipe(engine)) {
        return { ok: false, reason: `datastore service ${name} uses ${engine}, which has no build recipe yet` };
      }
      datastores.push({ service: name, engine, ...datastoreCredsFromEnv(svc.environment) });
      continue;
    }
    const port = firstPort(svc.ports) ?? firstPort(svc.expose);
    const isApp = port !== undefined || svc.build !== undefined;
    if (isApp) appCandidates.push({ name, port: port ?? 80, svc });
  }

  if (appCandidates.length === 0) return { ok: false, reason: "no app service exposes an HTTP port or a build" };
  if (appCandidates.length > 1) {
    return { ok: false, reason: `more than one app service (${appCandidates.map((a) => a.name).join(", ")}); cannot flatten to one image` };
  }
  if (datastores.length === 0) {
    return { ok: false, reason: "no recognised datastore service; a self-contained app is the dockerfile strategy" };
  }
  const app = appCandidates[0]!;
  const build = appBuildConfig(app.svc.build);
  if (!build) {
    return { ok: false, reason: `app service ${app.name} has no build context; a compose app that only pulls an image is the image strategy` };
  }
  const dsNames = new Set(datastores.map((d) => d.service));
  const envOverrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(normalizeEnv(app.svc.environment))) {
    if (dsNames.has(v)) envOverrides[k] = "127.0.0.1";
  }
  return {
    ok: true,
    appService: app.name,
    appPort: app.port,
    datastores,
    appContext: build.context,
    appDockerfile: build.dockerfile,
    envOverrides,
  };
}

export type ComposeMeshTopology =
  | { ok: true; appService: string; appPort: number; services: ComposeMeshService[] }
  | { ok: false; reason: string };

/**
 * Read a compose file into a mesh: every service runs as its own linked sandbox, so nothing is
 * flattened and no datastore recipe is needed (a dependency runs its real image). This handles the
 * multi-service repos parseComposeTopology rejects (more than one app, a datastore with no recipe
 * like postgres or mongo, an app that only pulls an image). It applies only to a genuine
 * multi-service topology: a single-service compose is left to the flatten path's own reasons.
 *
 * The app is the one service the agent probes: a non-datastore service that publishes an HTTP port.
 * Everything else is a dependency, reached by the app over the link group by its sandbox id, which
 * the provisioner substitutes for the compose service name at boot. Peers come from depends_on and
 * from env values that name another service, so the provisioner knows what to rewrite.
 */
export function parseComposeMesh(composeText: string): ComposeMeshTopology {
  let doc: unknown;
  try {
    doc = yaml.load(composeText);
  } catch {
    return { ok: false, reason: "compose file is not valid YAML" };
  }
  const services = (doc as { services?: Record<string, ComposeService> } | null)?.services;
  if (!services || typeof services !== "object") {
    return { ok: false, reason: "compose file declares no services" };
  }
  // Drop host-infra sidecars (a docker-socket monitor) before counting: they are not part of the app.
  const entries = Object.entries(services).filter(([, svc]) => !mountsDockerSocket(svc));
  if (entries.length < 2) {
    // A single application service is not a mesh; the flatten path's reason is clearer.
    return { ok: false, reason: "compose file has fewer than two application services" };
  }
  const allNames = new Set(entries.map(([name]) => name));

  // The app is a non-datastore service that publishes a web port. Prefer one with a host `ports`
  // mapping (the front door a compose author publishes), else the first with an exposed port.
  const appCandidates = entries.filter(([, svc]) => {
    const isDatastore = typeof svc.image === "string" && engineForImage(svc.image) !== undefined;
    if (isDatastore) return false;
    return (firstPort(svc.ports) ?? firstPort(svc.expose)) !== undefined;
  });
  if (appCandidates.length === 0) {
    return { ok: false, reason: "no service publishes an HTTP port to probe" };
  }
  const appEntry = appCandidates.find(([, svc]) => firstPort(svc.ports) !== undefined) ?? appCandidates[0]!;
  const appName = appEntry[0];
  const appPort = firstPort(appEntry[1].ports) ?? firstPort(appEntry[1].expose)!;

  const meshServices: ComposeMeshService[] = [];
  for (const [name, svc] of entries) {
    const build = appBuildConfig(svc.build);
    const rawImage = typeof svc.image === "string" ? svc.image : undefined;
    const image = rawImage ? resolveComposeImage(rawImage) : undefined;
    if (!build && !image) {
      return { ok: false, reason: `service ${name} has neither a build nor an image, so it cannot run` };
    }
    // A service listens where it maps or exposes a port; a datastore that declares neither still has
    // a well-known port, so the app can reach it and readiness can be checked.
    const port =
      firstPort(svc.ports) ?? firstPort(svc.expose) ?? (image ? datastorePortForImage(image) : undefined);
    const env = meshEnv(svc.environment);
    const peers = servicePeers(svc, allNames, name);
    meshServices.push({
      service: name,
      role: name === appName ? "app" : "dependency",
      ...(port !== undefined ? { port } : {}),
      // Prefer building from source when a service declares both a build and an image.
      ...(build
        ? { build: { context: build.context, ...(build.dockerfile !== "Dockerfile" ? { dockerfile: build.dockerfile } : {}) } }
        : { image: image! }),
      ...(Object.keys(env).length ? { env } : {}),
      ...(peers.length ? { peers } : {}),
    });
  }

  return { ok: true, appService: appName, appPort, services: meshServices };
}

/** The port a stock datastore listens on when the compose file names neither a mapping nor an
 *  expose. The app still needs to reach it and readiness still needs a port to poll. */
function datastorePortForImage(image: string): number | undefined {
  const name = image.toLowerCase();
  if (name.includes("mariadb") || name.includes("mysql") || name.includes("percona")) return 3306;
  if (name.includes("postgres")) return 5432;
  if (name.includes("redis")) return 6379;
  if (name.includes("mongo")) return 27017;
  return undefined;
}

/** compose env, restricted to entries a build plan accepts: env-name keys with single-line values. */
function meshEnv(environment: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(normalizeEnv(environment))) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !/[\r\n]/.test(v)) out[k] = v;
  }
  return out;
}

/** The compose service names a service connects to: its depends_on, plus any env value that names
 *  another service (a database host set to the db service's name). */
function servicePeers(svc: ComposeService, allNames: Set<string>, self: string): string[] {
  const peers = new Set<string>();
  const dep = svc.depends_on;
  if (Array.isArray(dep)) {
    for (const d of dep) if (typeof d === "string") peers.add(d);
  } else if (dep && typeof dep === "object") {
    for (const k of Object.keys(dep as Record<string, unknown>)) peers.add(k);
  }
  for (const v of Object.values(normalizeEnv(svc.environment))) if (allNames.has(v)) peers.add(v);
  peers.delete(self);
  return [...peers].filter((n) => allNames.has(n));
}

/** A compose `build:` is either a context string or `{ context, dockerfile }`. */
function appBuildConfig(build: unknown): { context: string; dockerfile: string } | undefined {
  if (typeof build === "string") return { context: build, dockerfile: "Dockerfile" };
  if (build && typeof build === "object") {
    const b = build as { context?: unknown; dockerfile?: unknown };
    const context = typeof b.context === "string" ? b.context : ".";
    const dockerfile = typeof b.dockerfile === "string" ? b.dockerfile : "Dockerfile";
    return { context, dockerfile };
  }
  return undefined;
}

function datastoreCredsFromEnv(environment: unknown): Partial<Pick<ComposeDatastore, "dbName" | "user" | "password">> {
  const env = normalizeEnv(environment);
  const dbName = env.MYSQL_DATABASE ?? env.MARIADB_DATABASE ?? env.POSTGRES_DB;
  const user = env.MYSQL_USER ?? env.MARIADB_USER ?? env.POSTGRES_USER;
  const password = env.MYSQL_PASSWORD ?? env.MARIADB_PASSWORD ?? env.POSTGRES_PASSWORD;
  return {
    ...(dbName ? { dbName } : {}),
    ...(user ? { user } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

/** compose `environment` is either a map or a list of `KEY=value` strings; normalize to a map. */
function normalizeEnv(environment: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(environment)) {
    for (const entry of environment) {
      if (typeof entry !== "string") continue;
      const eq = entry.indexOf("=");
      if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  } else if (environment && typeof environment === "object") {
    for (const [k, v] of Object.entries(environment as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number") out[k] = String(v);
    }
  }
  return out;
}

/** First host/container port from a compose `ports`/`expose` value, taking the container side. */
function firstPort(value: unknown): number | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    const text = String(entry);
    // "8080:80" -> 80 (container side); "80" -> 80; "127.0.0.1:8080:80" -> 80.
    const parts = text.split(":");
    const container = parts[parts.length - 1]?.replace(/\/.*/, "");
    const n = Number(container);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
}

/** The EXPOSE port declared in a Dockerfile, if any. */
export function dockerfileExposePort(dockerfileText: string): number | undefined {
  const match = dockerfileText.match(/^\s*EXPOSE\s+(\d+)/im);
  return match ? Number(match[1]) : undefined;
}

/** Lowercase profile name from a repo full name: "Vaibhav91one/DVWA" -> "dvwa". */
export function profileNameFromRepo(repoFullName: string): string {
  const repo = repoFullName.split("/").pop() ?? repoFullName;
  return repo.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "target";
}

/**
 * Read files from a public repo over raw.githubusercontent.com. Onboarding only enqueues public
 * repos (grantRepositories filters to `private === false`), so the source needs no token, and the
 * worker has ordinary egress (only the build and reproduction sandboxes are network-restricted).
 */
export function rawSourceReader(repoFullName: string, ref = "HEAD"): SourceReader {
  return {
    async readFile(path: string) {
      const res = await fetch(`https://raw.githubusercontent.com/${repoFullName}/${ref}/${path}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`reading ${path} from ${repoFullName} failed: ${res.status}`);
      return await res.text();
    },
  };
}

export type ClassifyOptions = {
  /** Seed step for a compose target that needs the app's own setup run at build (DVWA: /setup.php).
   *  Optional because the classifier cannot infer an app-specific seed; defaults to none. */
  composeSeedHint?: BuildPlan["seed"];
  /** Literal config-file rewrites for a compose target whose app hardcodes the datastore host in a
   *  file rather than reading it from an env var (DVWA's config.inc.php names `db`). */
  configRewritesHint?: Array<{ file: string; from: string; to: string }>;
  /** Readiness path override for an app whose "/" redirects (DVWA's "/" is a 302 to /login.php, and
   *  the readiness poll wants a 2xx). */
  readinessPathHint?: string;
  /** Extra image env for a compose app that reads its configuration from the environment, merged over
   *  (and winning against) the datastore-host overrides the classifier derives from the compose. This
   *  is where a known target sets the values that make its reported vulnerability reachable in the
   *  isolated sandbox: DVWA needs `low` security instead of its `impossible` default and its login
   *  wall off, so a stateless probe can reach the injectable page. */
  envOverridesHint?: Record<string, string>;
};

/**
 * Classify a repo into a build plan. Deterministic: a compose file with one app plus a recipe-backed
 * datastore flattens to compose-synth; a multi-service compose that does not flatten (more than one
 * app, a recipe-less datastore, an image-only app) becomes a compose-mesh of linked sandboxes; a
 * Dockerfile alone is the dockerfile strategy; anything else is not-flattenable with a reason.
 */
export async function classify(
  source: SourceReader,
  repoFullName: string,
  options: ClassifyOptions = {},
): Promise<BuildPlan> {
  const ecosystem = await detectEcosystem(source);
  const name = profileNameFromRepo(repoFullName);

  const compose = await readFirst(source, COMPOSE_PATHS);
  if (compose) {
    const topology = parseComposeTopology(compose.text);
    if (!topology.ok) {
      // The single-image flatten does not fit. Try the mesh: run every service as its own linked
      // sandbox, which covers the cases flatten rejects (more than one app, a recipe-less datastore
      // like postgres, an image-only app). If the mesh does not fit either, keep flatten's reason,
      // which is the clearer one for a single-service or genuinely unsupportable repo.
      const mesh = parseComposeMesh(compose.text);
      if (!mesh.ok) return { strategy: "not-flattenable", ecosystem, reason: topology.reason };

      const resolvedServices = mesh.services.map((service) =>
        service.build
          ? {
              ...service,
              build: resolveComposeBuild(compose.path, {
                context: service.build.context,
                dockerfile: service.build.dockerfile ?? "Dockerfile",
              }),
            }
          : service,
      );
      const appSvc = resolvedServices.find((s) => s.role === "app")!;
      let meshEcosystem = ecosystem;
      if (appSvc.build) {
        const appDockerfileText = await source.readFile(
          joinRepoPath(appSvc.build.context, appSvc.build.dockerfile ?? "Dockerfile"),
        );
        if (appDockerfileText) meshEcosystem = ecosystemFromDockerfile(appDockerfileText);
      }
      return {
        strategy: "compose-mesh",
        ecosystem: meshEcosystem,
        composePath: compose.path,
        appService: mesh.appService,
        services: resolvedServices,
        seed: options.composeSeedHint ?? { kind: "none" },
        runtime: {
          name,
          baseUrl: `http://localhost:${mesh.appPort}`,
          readinessPath: options.readinessPathHint ?? "/",
          // Several cold services (a database warming up) need a wider readiness budget than one app.
          warmupSeconds: 90,
        },
      };
    }
    // The app's own Dockerfile decides the ecosystem for a compose app, since its package manifest
    // may sit in a subdirectory the root scan misses. Fall back to the root scan if it reveals
    // nothing. The datastore install (apt) needs its own hosts regardless of the app's ecosystem.
    const resolvedAppBuild = resolveComposeBuild(compose.path, {
      context: topology.appContext,
      dockerfile: topology.appDockerfile,
    });
    const appDockerfilePath = joinRepoPath(resolvedAppBuild.context, resolvedAppBuild.dockerfile);
    const appDockerfileText = await source.readFile(appDockerfilePath);
    const appEcosystem = appDockerfileText ? ecosystemFromDockerfile(appDockerfileText) : "none";
    const composeEcosystem = appEcosystem !== "none" ? appEcosystem : ecosystem;
    const datastoreEgress = [
      ...new Set(topology.datastores.flatMap((d) => getDatastoreRecipe(d.engine)?.installEgressHosts ?? [])),
    ];

    return {
      strategy: "compose-synth",
      ecosystem: composeEcosystem,
      composePath: compose.path,
      appService: topology.appService,
      datastores: topology.datastores,
      appContext: resolvedAppBuild.context,
      appDockerfile: resolvedAppBuild.dockerfile,
      ...(datastoreEgress.length ? { extraEgressHosts: datastoreEgress } : {}),
      ...(options.configRewritesHint ? { configRewrites: options.configRewritesHint } : {}),
      ...(() => {
        // The hint wins over a compose-derived override for the same key, so a known target can steer
        // an env var the compose also sets (DVWA's DB_SERVER is rewritten to loopback by the datastore
        // pass; a hint here adds the security-level and auth env the compose does not carry).
        const env = { ...topology.envOverrides, ...(options.envOverridesHint ?? {}) };
        return Object.keys(env).length ? { envOverrides: env } : {};
      })(),
      seed: options.composeSeedHint ?? { kind: "none" },
      runtime: {
        name,
        baseUrl: `http://localhost:${topology.appPort}`,
        readinessPath: options.readinessPathHint ?? "/",
        // The synthesized image boots the app from its own entrypoint, so no startCommand; give a
        // datastore a warmup budget for its cold start.
        warmupSeconds: 60,
      },
    };
  }

  const dockerfile = await source.readFile("Dockerfile");
  if (dockerfile) {
    const port = dockerfileExposePort(dockerfile) ?? 8080;
    return {
      strategy: "dockerfile",
      ecosystem,
      dockerfilePath: "Dockerfile",
      buildContext: ".",
      seed: { kind: "none" },
      runtime: { name, baseUrl: `http://localhost:${port}`, readinessPath: "/" },
    };
  }

  return {
    strategy: "not-flattenable",
    ecosystem,
    reason: "repo has neither a Dockerfile nor a flattenable compose file",
  };
}

/** Join a compose build context and Dockerfile into a repo-relative path ("." + "Dockerfile" ->
 *  "Dockerfile", "app" + "Dockerfile" -> "app/Dockerfile"). */
function joinRepoPath(context: string, dockerfile: string): string {
  const base = context.replace(/^\.\/?/, "").replace(/\/+$/, "");
  return base ? `${base}/${dockerfile}` : dockerfile;
}

/** Resolve a Compose-relative path against the directory containing its manifest. */
function resolveComposePath(composePath: string, relativePath: string): string {
  if (path.posix.isAbsolute(relativePath)) {
    throw new Error(`compose build path must be repository-relative: ${relativePath}`);
  }
  const composeDir = path.posix.dirname(composePath);
  const resolved = path.posix.normalize(path.posix.join(composeDir, relativePath));
  if (resolved === ".." || resolved.startsWith("../")) {
    throw new Error(`compose path escapes repository: ${relativePath}`);
  }
  return resolved;
}

function resolveComposeBuild(composePath: string, build: { context: string; dockerfile: string }) {
  return {
    context: resolveComposePath(composePath, build.context),
    dockerfile: build.dockerfile,
  };
}

async function readFirst(
  source: SourceReader,
  paths: string[],
): Promise<{ path: string; text: string } | null> {
  for (const path of paths) {
    const text = await source.readFile(path);
    if (text !== null) return { path, text };
  }
  return null;
}

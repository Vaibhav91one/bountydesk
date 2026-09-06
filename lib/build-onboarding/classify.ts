import yaml from "js-yaml";

import {
  type BuildPlan,
  type ComposeDatastore,
  type DatastoreEngine,
  type Ecosystem,
} from "./build-plan";
import { hasDatastoreRecipe } from "./datastore-recipes";

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

const COMPOSE_PATHS = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

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

type ComposeService = {
  image?: string;
  build?: unknown;
  ports?: unknown;
  expose?: unknown;
  environment?: unknown;
  command?: unknown;
};

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
};

/**
 * Classify a repo into a build plan. Deterministic: a compose file with one app plus known datastores
 * is compose-synth, a Dockerfile alone is the dockerfile strategy, and anything that does not reduce
 * to one image is not-flattenable with a reason.
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
      // A compose file that cannot flatten is a clear not-flattenable, not a fall-through to a
      // Dockerfile build that would produce an app with no datastore.
      return { strategy: "not-flattenable", ecosystem, reason: topology.reason };
    }
    return {
      strategy: "compose-synth",
      ecosystem,
      composePath: compose.path,
      appService: topology.appService,
      datastores: topology.datastores,
      appContext: topology.appContext,
      appDockerfile: topology.appDockerfile,
      ...(options.configRewritesHint ? { configRewrites: options.configRewritesHint } : {}),
      ...(Object.keys(topology.envOverrides).length ? { envOverrides: topology.envOverrides } : {}),
      seed: options.composeSeedHint ?? { kind: "none" },
      runtime: {
        name,
        baseUrl: `http://localhost:${topology.appPort}`,
        readinessPath: "/",
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

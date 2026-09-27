import type { SourceReader } from "@/lib/build-onboarding/classify";

/**
 * An advisory dependency scan: read the repo's manifests and lockfiles, ask OSV.dev which of the
 * declared packages have known vulnerabilities, and report the matches as Observation-tier evidence
 * beside the static review.
 *
 * This is deliberately weak evidence. It is a lookup against a public database, not a check that the
 * vulnerable code path is reached or exploitable, so it can never say REPRODUCED and never gates a
 * verdict (docs/decisions.md Q6, Q22). It runs host-side, in the worker's static pass, because the
 * reproduction sandboxes are offline and OSV is an outbound HTTP call.
 *
 * Everything here fails open. A malformed manifest parses to nothing rather than throwing, and OSV
 * being unreachable returns no matches rather than failing the static pass it is a supplement to.
 */

export type OsvEcosystem = "npm" | "PyPI" | "Go" | "Maven" | "RubyGems" | "Packagist" | "crates.io";

export type Dependency = { ecosystem: OsvEcosystem; name: string; version: string };

export type DependencyAdvisory = Dependency & {
  /** OSV vulnerability ids, e.g. GHSA-xxxx or CVE-xxxx. querybatch returns ids only, which is all an
   *  advisory signal needs; the agent or a reader can look up details on osv.dev. */
  ids: string[];
};

/** Cap the packages sent to OSV so a giant lockfile cannot turn one static pass into a huge request.
 *  querybatch itself takes many more, but 300 is plenty for an advisory signal. */
export const MAX_QUERIED_PACKAGES = 300;

const OSV_QUERYBATCH_URL = "https://api.osv.dev/v1/querybatch";
const OSV_TIMEOUT_MS = 15_000;

/**
 * The files worth reading, in priority order per ecosystem: the lockfile first (exact, resolved
 * versions), then the manifest as a fallback (version ranges we clean to a best-effort concrete
 * version). Dedupe keeps the first version seen for a given ecosystem+name, so a lockfile entry wins
 * over the same package in the manifest.
 */
const SCAN_FILES: Array<{ path: string; parse: (text: string) => Dependency[] }> = [
  { path: "package-lock.json", parse: parseNpmLock },
  { path: "package.json", parse: parsePackageJson },
  { path: "poetry.lock", parse: parsePoetryLock },
  { path: "requirements.txt", parse: parseRequirementsTxt },
  { path: "go.sum", parse: parseGoSum },
  { path: "go.mod", parse: parseGoMod },
  { path: "Gemfile.lock", parse: parseGemfileLock },
  { path: "composer.lock", parse: parseComposerLock },
  { path: "composer.json", parse: parseComposerJson },
  { path: "Cargo.lock", parse: parseCargoLock },
  { path: "Cargo.toml", parse: parseCargoManifest },
  { path: "pom.xml", parse: parsePomXml },
];

/** Parse every supported manifest and lockfile in the corpus into a deduped dependency list. Pure:
 *  no I/O, and any file that does not parse contributes nothing. */
export function parseDependencies(files: Array<{ path: string; text: string }>): Dependency[] {
  const byPath = new Map(files.map((f) => [f.path, f.text] as const));
  const seen = new Set<string>();
  const out: Dependency[] = [];
  for (const { path, parse } of SCAN_FILES) {
    const text = byPath.get(path);
    if (text === undefined) continue;
    let deps: Dependency[];
    try {
      deps = parse(text);
    } catch {
      // A truncated lockfile or malformed manifest is not a failure of the pass, just no data here.
      deps = [];
    }
    for (const dep of deps) {
      const key = `${dep.ecosystem}::${dep.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(dep);
    }
  }
  return out;
}

/** POST the dependencies to OSV querybatch and return only the ones with at least one advisory.
 *  Never throws: OSV being down, slow, or returning garbage yields no matches. `fetchImpl` is injected
 *  so tests can drive it without a network. */
export async function queryOsv(
  deps: Dependency[],
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<DependencyAdvisory[]> {
  const capped = deps.slice(0, MAX_QUERIED_PACKAGES);
  if (capped.length === 0) return [];
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(OSV_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    const res = await fetchImpl(OSV_QUERYBATCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: capped.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })),
      }),
      signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { results?: Array<{ vulns?: Array<{ id?: unknown }> }> };
    const results = body.results ?? [];
    // querybatch returns results aligned by index with the queries we sent.
    const advisories: DependencyAdvisory[] = [];
    capped.forEach((dep, i) => {
      const ids = (results[i]?.vulns ?? [])
        .map((v) => v.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      if (ids.length > 0) advisories.push({ ...dep, ids });
    });
    return advisories;
  } catch {
    return [];
  }
}

/** Read the manifests and lockfiles through the same bounded reader the static review uses, then look
 *  the dependencies up in OSV. Never throws, for the same reason the static pass is fail-open. */
export async function scanDependencies(
  source: SourceReader,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<DependencyAdvisory[]> {
  const files: Array<{ path: string; text: string }> = [];
  for (const { path } of SCAN_FILES) {
    const text = await source.readFile(path).catch(() => null);
    if (text !== null && text.trim().length > 0) files.push({ path, text });
  }
  const deps = parseDependencies(files);
  return queryOsv(deps, opts);
}

/** The Observation-tier block appended to a static-review turn message. Null when there is nothing to
 *  report, so the caller adds no empty section. The advisories are framed as the weakest evidence tier
 *  precisely so the agent cannot mistake them for a reproduction. */
export function dependencyAdvisorySection(advisories: DependencyAdvisory[]): string | null {
  if (advisories.length === 0) return null;
  const lines = advisories.map((a) => `- ${a.ecosystem} ${a.name}@${a.version}: ${a.ids.join(", ")}`);
  return `Advisory dependency findings (Observation tier, weakest evidence): a lookup of the declared dependencies against OSV.dev found the following known-vulnerable packages. This is a database match on a version string, not proof the vulnerable code is reached or exploitable, so it never establishes REPRODUCED and does not change the ANALYSIS_ONLY outcome. Treat it as a supplement to note, not a reproduction.

${lines.join("\n")}`;
}

// Parsers. Each takes raw file text and returns whatever exact-version dependencies it can read. They
// return [] on anything ambiguous or malformed rather than guessing, since a false version produces a
// false OSV match or miss and this is only an advisory signal.

/** Strip a range operator to a best-effort concrete version, or null when the requirement is a real
 *  range we should not collapse. ponytail: naive single-version extraction, good enough for an advisory
 *  lookup; a resolver would be the upgrade if false matches ever matter. */
function cleanVersion(raw: string): string | null {
  const trimmed = raw.trim().replace(/^[v=^~]+/, "").trim();
  // A comma or a second comparator means a true range; a wildcard or tag is not a version.
  if (/[,|]|\s(?:-|<|>)/.test(trimmed) || /[<>*]/.test(trimmed) || /^(latest|\*|x)$/i.test(trimmed)) return null;
  const m = trimmed.match(/^(\d+(?:\.\d+){0,2}(?:[.\-+][0-9A-Za-z.\-]+)?)/);
  return m ? m[1]! : null;
}

function parsePackageJson(text: string): Dependency[] {
  const json = JSON.parse(text) as Record<string, unknown>;
  const out: Dependency[] = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const deps = json[field];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof range !== "string") continue;
      const version = cleanVersion(range);
      if (version) out.push({ ecosystem: "npm", name, version });
    }
  }
  return out;
}

function parseNpmLock(text: string): Dependency[] {
  const json = JSON.parse(text) as { packages?: Record<string, { version?: unknown }>; dependencies?: Record<string, { version?: unknown }> };
  const out: Dependency[] = [];
  // lockfileVersion 2/3: the "packages" map keys installed paths; the root "" and non-node_modules keys are skipped.
  if (json.packages) {
    for (const [path, info] of Object.entries(json.packages)) {
      const marker = "node_modules/";
      const at = path.lastIndexOf(marker);
      if (at < 0) continue;
      const name = path.slice(at + marker.length);
      if (name && typeof info?.version === "string") out.push({ ecosystem: "npm", name, version: info.version });
    }
  }
  // lockfileVersion 1: the flat "dependencies" map is name -> { version }.
  if (out.length === 0 && json.dependencies) {
    for (const [name, info] of Object.entries(json.dependencies)) {
      if (typeof info?.version === "string") out.push({ ecosystem: "npm", name, version: info.version });
    }
  }
  return out;
}

function parseRequirementsTxt(text: string): Dependency[] {
  const out: Dependency[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line.startsWith("-")) continue;
    // Only pin-exact requirements carry a version we can trust; a range is left for the manifest to miss.
    const m = line.match(/^([A-Za-z0-9._-]+)\s*==\s*([0-9][0-9A-Za-z.\-+]*)/);
    if (m) out.push({ ecosystem: "PyPI", name: m[1]!, version: m[2]! });
  }
  return out;
}

function parsePoetryLock(text: string): Dependency[] {
  return parseTomlPackages(text, "PyPI");
}

function parseGoMod(text: string): Dependency[] {
  const out: Dependency[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    const m = line.match(/^(?:require\s+)?([\w.\-/]+\.[\w.\-/]+)\s+v([0-9][\w.\-+]*)/);
    if (m) out.push({ ecosystem: "Go", name: m[1]!, version: `v${m[2]!}` });
  }
  return out;
}

function parseGoSum(text: string): Dependency[] {
  const seen = new Set<string>();
  const out: Dependency[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // go.sum lists each module twice (the zip and its go.mod); one entry per module is enough.
    const m = raw.match(/^([\w.\-/]+)\s+v([0-9][\w.\-+]*?)(?:\/go\.mod)?\s+h1:/);
    if (m && !seen.has(m[1]!)) {
      seen.add(m[1]!);
      out.push({ ecosystem: "Go", name: m[1]!, version: `v${m[2]!}` });
    }
  }
  return out;
}

function parseComposerJson(text: string): Dependency[] {
  const json = JSON.parse(text) as Record<string, unknown>;
  const out: Dependency[] = [];
  for (const field of ["require", "require-dev"]) {
    const deps = json[field];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
      // "php" and "ext-*" platform requirements are not packages OSV tracks.
      if (name === "php" || name.startsWith("ext-") || typeof range !== "string") continue;
      const version = cleanVersion(range);
      if (version) out.push({ ecosystem: "Packagist", name, version });
    }
  }
  return out;
}

function parseComposerLock(text: string): Dependency[] {
  const json = JSON.parse(text) as { packages?: Array<{ name?: unknown; version?: unknown }> };
  const out: Dependency[] = [];
  for (const pkg of json.packages ?? []) {
    if (typeof pkg?.name === "string" && typeof pkg?.version === "string") {
      out.push({ ecosystem: "Packagist", name: pkg.name, version: pkg.version.replace(/^v/, "") });
    }
  }
  return out;
}

function parseGemfileLock(text: string): Dependency[] {
  const out: Dependency[] = [];
  let inSpecs = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s{2,4}specs:/.test(raw)) { inSpecs = true; continue; }
    if (inSpecs && /^\S/.test(raw)) inSpecs = false;
    if (!inSpecs) continue;
    // A resolved spec is indented four spaces "    name (1.2.3)"; its dependencies are indented six.
    const m = raw.match(/^\s{4}([A-Za-z0-9._-]+) \(([0-9][0-9A-Za-z.\-]*)\)/);
    if (m) out.push({ ecosystem: "RubyGems", name: m[1]!, version: m[2]! });
  }
  return out;
}

function parseCargoManifest(text: string): Dependency[] {
  const out: Dependency[] = [];
  let inDeps = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[/.test(line)) { inDeps = /^\[(?:.*\.)?(?:dependencies|dev-dependencies|build-dependencies)\]$/.test(line); continue; }
    if (!inDeps) continue;
    // name = "1.2.3" or name = { version = "1.2.3" }
    const m = line.match(/^([A-Za-z0-9._-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*\bversion\s*=\s*"([^"]+)")/);
    if (m) {
      const version = cleanVersion(m[2] ?? m[3] ?? "");
      if (version) out.push({ ecosystem: "crates.io", name: m[1]!, version });
    }
  }
  return out;
}

function parseCargoLock(text: string): Dependency[] {
  return parseTomlPackages(text, "crates.io");
}

/** Shared reader for the [[package]] blocks that poetry.lock and Cargo.lock both use: name and version
 *  as adjacent quoted keys. */
function parseTomlPackages(text: string, ecosystem: OsvEcosystem): Dependency[] {
  const out: Dependency[] = [];
  let name: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "[[package]]") { name = null; continue; }
    const nameM = line.match(/^name\s*=\s*"([^"]+)"/);
    if (nameM) { name = nameM[1]!; continue; }
    const verM = line.match(/^version\s*=\s*"([^"]+)"/);
    if (verM && name) { out.push({ ecosystem, name, version: verM[1]! }); name = null; }
  }
  return out;
}

function parsePomXml(text: string): Dependency[] {
  const out: Dependency[] = [];
  const re = /<dependency>([\s\S]*?)<\/dependency>/g;
  let block: RegExpExecArray | null;
  while ((block = re.exec(text)) !== null) {
    const g = block[1]!.match(/<groupId>([^<]+)<\/groupId>/)?.[1]?.trim();
    const a = block[1]!.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim();
    const v = block[1]!.match(/<version>([^<]+)<\/version>/)?.[1]?.trim();
    // A property placeholder version (${...}) cannot be resolved without the full POM, so skip it.
    if (g && a && v && !v.includes("${")) out.push({ ecosystem: "Maven", name: `${g}:${a}`, version: v });
  }
  return out;
}

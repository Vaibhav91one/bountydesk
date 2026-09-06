import { type SourceReader } from "@/lib/build-onboarding/classify";

/**
 * A static reachability pre-check, the step Konvu's product is built on: decide, without running the
 * app, whether a report's subject is even present in the code, so an obviously-absent finding does not
 * cost a full build-and-reproduce, and a run that cannot reproduce can end as an evidenced
 * ANALYSIS_ONLY rather than a bare "could not reproduce".
 *
 * It is deliberately bounded and honest. The strong, deterministic signal is a dependency: is the
 * named package actually declared in the repo's manifest (so the vulnerable code is even shipped). A
 * symbol or endpoint named in the report is checked against a few source files where present, but the
 * absence of a full call graph means the answer for those is usually "unknown", and it says so. It
 * never lifts a verdict past the authorization gate: it produces evidence and a recommendation, not a
 * REPRODUCED.
 */

export type ReachabilitySignal =
  | { kind: "dependency"; value: string }
  | { kind: "symbol"; value: string; files?: string[] }
  | { kind: "endpoint"; value: string; files?: string[] };

export type SignalFinding = {
  signal: ReachabilitySignal;
  status: "present" | "absent" | "unknown";
  evidence: string;
};

export type ReachabilityAssessment = {
  /** reachable-candidate: at least one signal is present, so a reproduction is worth running.
   *  unreachable: every signal we could decide is absent, so the report can be dismissed or held as
   *  ANALYSIS_ONLY with this as the reason. unknown: nothing could be decided statically. */
  status: "reachable-candidate" | "unreachable" | "unknown";
  findings: SignalFinding[];
  /** A one-line, human-readable summary for the verdict evidence trail. */
  summary: string;
};

const DEPENDENCY_MANIFESTS: Array<{ file: string; contains(text: string, dep: string): boolean }> = [
  { file: "package.json", contains: (t, d) => new RegExp(`"${escapeRe(d)}"\\s*:`).test(t) },
  { file: "requirements.txt", contains: (t, d) => new RegExp(`^\\s*${escapeRe(d)}(\\b|[=<>~!])`, "im").test(t) },
  { file: "pyproject.toml", contains: (t, d) => t.toLowerCase().includes(d.toLowerCase()) },
  { file: "composer.json", contains: (t, d) => new RegExp(`"${escapeRe(d)}"\\s*:`).test(t) },
  { file: "go.mod", contains: (t, d) => t.includes(d) },
  { file: "Gemfile", contains: (t, d) => new RegExp(`gem\\s+['"]${escapeRe(d)}['"]`).test(t) },
  { file: "pom.xml", contains: (t, d) => t.includes(d) },
  { file: "build.gradle", contains: (t, d) => t.includes(d) },
];

async function assessDependency(source: SourceReader, dep: string): Promise<SignalFinding> {
  const bare = dep.split(/[@:]/)[0]!.trim();
  for (const manifest of DEPENDENCY_MANIFESTS) {
    const text = await source.readFile(manifest.file);
    if (text === null) continue;
    if (manifest.contains(text, bare)) {
      return { signal: { kind: "dependency", value: dep }, status: "present", evidence: `${bare} is declared in ${manifest.file}` };
    }
  }
  // A manifest existed but did not declare it → genuinely absent; no manifest at all → unknown.
  const anyManifest = await firstPresent(source, DEPENDENCY_MANIFESTS.map((m) => m.file));
  return anyManifest
    ? { signal: { kind: "dependency", value: dep }, status: "absent", evidence: `${bare} is not declared in ${anyManifest}` }
    : { signal: { kind: "dependency", value: dep }, status: "unknown", evidence: "no dependency manifest found to check against" };
}

async function assessTerm(source: SourceReader, signal: ReachabilitySignal): Promise<SignalFinding> {
  const files = ("files" in signal && signal.files) || [];
  if (files.length === 0) {
    return { signal, status: "unknown", evidence: `no source files named to search for ${signal.value}; static reachability of a ${signal.kind} needs a call graph` };
  }
  for (const file of files) {
    const text = await source.readFile(file);
    if (text && text.includes(signal.value)) {
      return { signal, status: "present", evidence: `${signal.value} appears in ${file}` };
    }
  }
  return { signal, status: "absent", evidence: `${signal.value} was not found in the named files` };
}

export async function assessReachability(
  source: SourceReader,
  signals: ReachabilitySignal[],
): Promise<ReachabilityAssessment> {
  if (signals.length === 0) {
    return { status: "unknown", findings: [], summary: "no reachability signals extracted from the report" };
  }

  const findings: SignalFinding[] = [];
  for (const signal of signals) {
    findings.push(signal.kind === "dependency" ? await assessDependency(source, signal.value) : await assessTerm(source, signal));
  }

  const decided = findings.filter((f) => f.status !== "unknown");
  let status: ReachabilityAssessment["status"];
  if (findings.some((f) => f.status === "present")) status = "reachable-candidate";
  else if (decided.length > 0 && decided.every((f) => f.status === "absent")) status = "unreachable";
  else status = "unknown";

  return { status, findings, summary: summarize(status, findings) };
}

function summarize(status: ReachabilityAssessment["status"], findings: SignalFinding[]): string {
  const present = findings.filter((f) => f.status === "present").length;
  const absent = findings.filter((f) => f.status === "absent").length;
  const unknown = findings.filter((f) => f.status === "unknown").length;
  const counts = `${present} present, ${absent} absent, ${unknown} unknown`;
  if (status === "reachable-candidate") return `reachable candidate (${counts}); a live reproduction is warranted`;
  if (status === "unreachable") return `not reachable (${counts}); the reported subject is not present in the code`;
  return `reachability unknown (${counts}); static analysis could not decide`;
}

async function firstPresent(source: SourceReader, files: string[]): Promise<string | null> {
  for (const file of files) {
    if ((await source.readFile(file)) !== null) return file;
  }
  return null;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

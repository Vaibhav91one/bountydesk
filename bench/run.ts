/**
 * Benchmark runner: files bench/corpus.json through the real intake-to-verdict pipeline and
 * collects the agent's own drafted verdict per case, for bench/score.ts to score.
 *
 * This is intentionally not a new intake surface. A case is created the same way ensureReport
 * creates any report, is bound (or not) to the already-connected Vaibhav91one/juice-shop target the
 * same way a connected GitHub repository's report is, and is handed to the job queue through the
 * exact `gate-analysis` payload lib/triage/gate.ts's releaseForAnalysis already uses to release a
 * gated report for an analysis-only run. The only new code is wiring, not a new way for an agent
 * to reach a target.
 *
 * Every report this creates is tagged `[bench]` in its title and is NEVER approved or delivered:
 * `file` only creates reports and enqueues jobs, `collect` only reads the verdict table, and
 * `cleanup` only cancels. There is no approval call anywhere in this file. `publish_verdict`'s own
 * human gate is untouched; this script cannot reach it.
 *
 * Gated three ways against running by accident or against production: the subcommand itself
 * (nothing runs without one), --commit on `file` and `cleanup` (a dry run otherwise), and
 * assertLocal, which refuses anything but a loopback DATABASE_URL, the same guard
 * scripts/seed-reports.ts uses for the same reason: these are reports the terminal-state DB
 * triggers make impossible to delete.
 *
 * This file is not executed as part of CI or this PR; filing a case starts a real TrueForge
 * session against a Daytona sandbox, which needs that harness and its credentials running
 * locally. See docs/benchmark.md for how to run it by hand.
 *
 *   node --env-file-if-exists=.env.local --import tsx bench/run.ts file --commit [--split=dev|test|all] [--ids=a,b]
 *   node --env-file-if-exists=.env.local --import tsx bench/run.ts collect --run=<runId>
 *   node --env-file-if-exists=.env.local --import tsx bench/run.ts cleanup --run=<runId> --commit
 *
 * `file` prints a runId and writes bench/.runs/<runId>.json (git-ignored), the manifest the other
 * two subcommands read. Between `file` and `collect`, something has to actually drain the job
 * queue and let each report's agent session run to a verdict or a terminal non-verdict state:
 * `npm run worker:jobs` repeatedly, or `npm run worker:daemon` left running.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { client, connectedRepository, db, desc, eq, report, verdict } from "@/lib/db";
import { enqueue } from "@/lib/jobs/queue";
import { ensureReport } from "@/lib/reports/lifecycle";
import { retireReports } from "@/lib/reports/retire";

import corpus from "./corpus.json" with { type: "json" };
import type { ActualOutcome, GroundTruthOutcome } from "./score";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(HERE, ".runs");

type Case = {
  id: string;
  split: "dev" | "test";
  kind: "positive" | "negative";
  negativeType?: "fixed" | "wrong-payload" | "informative" | "duplicate" | "unbound";
  expected: GroundTruthOutcome;
  title: string;
  body: string;
};

const CASES = corpus.cases as Case[];
const TARGET_REPO_FULL_NAME = corpus.target.repo;

type Manifest = {
  runId: string;
  filedAt: string;
  entries: Array<{ caseId: string; expected: GroundTruthOutcome; reportId: string }>;
};

function assertLocal(): void {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error(
      `refusing to run the benchmark against ${host}: it writes rows the DB cannot delete, so it only runs against a local database`,
    );
  }
}

function parseArgs(argv: string[]): { commit: boolean; split: "dev" | "test" | "all"; ids: string[] | null; run: string | null } {
  const commit = argv.includes("--commit");
  const splitArg = argv.find((a) => a.startsWith("--split="))?.slice("--split=".length);
  const split = splitArg === "dev" || splitArg === "test" ? splitArg : "all";
  const idsArg = argv.find((a) => a.startsWith("--ids="))?.slice("--ids=".length);
  const ids = idsArg ? idsArg.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const run = argv.find((a) => a.startsWith("--run="))?.slice("--run=".length) ?? null;
  return { commit, split, ids, run };
}

function manifestPath(runId: string): string {
  return join(RUNS_DIR, `${runId}.json`);
}

function readManifest(runId: string): Manifest {
  return JSON.parse(readFileSync(manifestPath(runId), "utf8")) as Manifest;
}

/** The connected repository's ids, read once. Fails loudly rather than seeding one itself: a
 *  benchmark run should bind to whatever target this database already has, the same one a real
 *  report would, not conjure a fresh one that nothing else points at. */
async function demoTarget(): Promise<{ connectedRepositoryId: string; targetProfileId: string }> {
  const [row] = await db
    .select({ id: connectedRepository.id, targetProfileId: connectedRepository.targetProfileId })
    .from(connectedRepository)
    .where(eq(connectedRepository.fullName, TARGET_REPO_FULL_NAME));

  if (!row) {
    throw new Error(
      `no connected repository ${TARGET_REPO_FULL_NAME} in this database; run npm run seed:target first`,
    );
  }
  // Every bound case in this corpus expects reproduction to actually run against a built,
  // pinned snapshot. A repository connected but not yet onboarded to a TargetProfile would
  // file these as ANALYSIS_ONLY for the wrong reason (no target, not "investigated and found
  // nothing"), silently corrupting every bound case's result, so refuse rather than file them.
  if (!row.targetProfileId) {
    throw new Error(
      `${TARGET_REPO_FULL_NAME} has no targetProfileId yet; onboard it before filing bound cases`,
    );
  }
  return { connectedRepositoryId: row.id, targetProfileId: row.targetProfileId };
}

function selectCases(opts: { split: "dev" | "test" | "all"; ids: string[] | null }): Case[] {
  let cases = CASES;
  if (opts.split !== "all") cases = cases.filter((c) => c.split === opts.split);
  if (opts.ids) cases = cases.filter((c) => opts.ids!.includes(c.id));
  return cases;
}

/** File every selected case as a report and enqueue its analysis job, same path a released
 *  gated report takes. Dry run (lists what it would file) unless --commit. */
async function file(opts: { commit: boolean; split: "dev" | "test" | "all"; ids: string[] | null }): Promise<void> {
  const cases = selectCases(opts);
  if (cases.length === 0) throw new Error("no cases matched the given --split/--ids");

  const runId = `bench-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  console.log(`run ${runId}: ${cases.length} case(s)${opts.commit ? "" : " (dry run, pass --commit to file)"}`);

  if (!opts.commit) {
    for (const c of cases) console.log(`  would file  ${c.id}  [${c.split}]  expected=${c.expected}`);
    return;
  }

  const target = await demoTarget();
  const entries: Manifest["entries"] = [];

  for (const c of cases) {
    const bound = c.negativeType !== "unbound";
    const sourceRef = `bench:${runId}:${c.id}`;
    const reportId = await ensureReport({
      channel: "upload",
      sourceRef,
      title: `[bench] ${c.title}`,
      body: c.body,
      reporterHandle: "bountydesk-bench",
      state: "TRIAGING",
      connectedRepositoryId: bound ? target.connectedRepositoryId : null,
      targetProfileId: bound ? target.targetProfileId : null,
    });

    await enqueue({
      channel: "email",
      deliveryId: `${sourceRef}:gate-analysis`,
      payload: { intake: "gate-analysis", reportId },
    });

    entries.push({ caseId: c.id, expected: c.expected, reportId });
    console.log(`  filed  ${c.id}  -> report ${reportId}`);
  }

  mkdirSync(RUNS_DIR, { recursive: true });
  const manifest: Manifest = { runId, filedAt: new Date().toISOString(), entries };
  writeFileSync(manifestPath(runId), JSON.stringify(manifest, null, 2));
  console.log(`\nwrote ${manifestPath(runId)}`);
  console.log("run the worker (npm run worker:jobs, repeatedly, or npm run worker:daemon) until every");
  console.log("report below reaches a verdict or a terminal non-verdict state, then run collect.");
}

/** The agent's own latest drafted verdict per report, or null if none exists yet (or ever: a
 *  report that ended DENIED/OUT_OF_SCOPE/CANCELLED at a gate before analysis drafts nothing). */
async function latestVerdictOutcome(reportId: string): Promise<ActualOutcome | null> {
  const [row] = await db
    .select({ outcome: verdict.outcome })
    .from(verdict)
    .where(eq(verdict.reportId, reportId))
    .orderBy(desc(verdict.revision))
    .limit(1);
  return (row?.outcome as ActualOutcome | undefined) ?? null;
}

/** Read the manifest's reports back and print a results.json next to it: one entry per case that
 *  has a drafted verdict, and a separate warning list for any that do not yet (or never will). */
async function collect(runId: string): Promise<void> {
  const manifest = readManifest(runId);
  const results: Array<{ id: string; expected: GroundTruthOutcome; actual: ActualOutcome }> = [];
  const noVerdict: Array<{ id: string; reportId: string; state: string }> = [];

  for (const entry of manifest.entries) {
    const [row] = await db
      .select({ state: report.state })
      .from(report)
      .where(eq(report.id, entry.reportId));

    const outcome = await latestVerdictOutcome(entry.reportId);
    if (outcome) {
      results.push({ id: entry.caseId, expected: entry.expected, actual: outcome });
    } else {
      noVerdict.push({ id: entry.caseId, reportId: entry.reportId, state: row?.state ?? "missing" });
    }
  }

  const outPath = join(RUNS_DIR, `${runId}.results.json`);
  writeFileSync(outPath, JSON.stringify({ runId, results, noVerdict }, null, 2));
  console.log(`${results.length}/${manifest.entries.length} case(s) have a drafted verdict`);
  if (noVerdict.length > 0) {
    console.log(`${noVerdict.length} case(s) have no verdict yet (still running, or ended with no draft):`);
    for (const n of noVerdict) console.log(`  ${n.id}  report ${n.reportId}  state=${n.state}`);
  }
  console.log(`wrote ${outPath}`);
}

/** Cancel every non-terminal report the run filed, through the same operator function
 *  scripts/retire-test-reports.ts uses. Never approves or delivers anything; a report already
 *  terminal (DENIED, OUT_OF_SCOPE) is left alone. Dry run unless --commit. */
async function cleanup(runId: string, commit: boolean): Promise<void> {
  const manifest = readManifest(runId);
  const ids = manifest.entries.map((e) => e.reportId);
  const outcomes = await retireReports(ids, { reason: `benchmark run ${runId} cleanup`, to: "CANCELLED", commit });
  for (const o of outcomes) {
    const from = "from" in o ? o.from : "-";
    console.log(`${o.reportId}  ${from}  ${o.status}`);
  }
  if (!commit) console.log("\ndry run, nothing written. Pass --commit to apply.");
}

async function main(): Promise<void> {
  assertLocal();
  const [sub, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  if (sub === "file") return file(opts);
  if (sub === "collect") {
    if (!opts.run) throw new Error("collect needs --run=<runId>");
    return collect(opts.run);
  }
  if (sub === "cleanup") {
    if (!opts.run) throw new Error("cleanup needs --run=<runId>");
    return cleanup(opts.run, opts.commit);
  }

  console.error("usage: bench/run.ts file|collect|cleanup [--commit] [--split=dev|test|all] [--ids=a,b] [--run=<runId>]");
  process.exit(1);
}

main()
  .then(async () => {
    await client.end({ timeout: 5 });
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await client.end({ timeout: 5 }).catch(() => undefined);
    process.exit(1);
  });

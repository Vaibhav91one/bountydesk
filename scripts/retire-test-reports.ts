/**
 * Operator tool: retire named test reports to CANCELLED (or EXPIRED), so leftover smoke rows stop
 * sitting in the queue as if a human still owed them a decision.
 *
 * Reports are named by id, one or more, and the run is a dry run unless --commit is passed. Both
 * target states are terminal, so there is no undo: read the dry run before committing it.
 *
 *   node --env-file-if-exists=.env.local --import tsx scripts/retire-test-reports.ts <id> <id> ...
 *   node --env-file-if-exists=.env.local --import tsx scripts/retire-test-reports.ts --commit <id>
 *   ... --expired --reason="left over from the 2026-08-31 cloud smoke run" --commit <id>
 *
 * A retired report's agent session stops polling on its next tick, and a report caught mid
 * delivery has its next delivery attempt refused and recorded. Hiding the row from the lists is a
 * separate step: scripts/hide-reports.ts.
 */
import { client } from "@/lib/db";
import { retireReports } from "@/lib/reports/retire";

const DEFAULT_REASON = "retired by an operator: leftover test report";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const commit = args.includes("--commit");
  const to = args.includes("--expired") ? "EXPIRED" : "CANCELLED";
  const reason = args.find((arg) => arg.startsWith("--reason="))?.slice("--reason=".length);
  const ids = args.filter((arg) => !arg.startsWith("--"));

  if (ids.length === 0) {
    console.error(
      "usage: retire-test-reports.ts [--commit] [--expired] [--reason=<why>] <report-id> [<report-id> ...]",
    );
    process.exit(1);
  }

  const outcomes = await retireReports(ids, { reason: reason ?? DEFAULT_REASON, to, commit });

  for (const outcome of outcomes) {
    const from = "from" in outcome ? outcome.from : "-";
    console.log(`${outcome.reportId}  ${from} -> ${outcome.status === "missing" || outcome.status === "already-terminal" ? "(skipped)" : to}  ${outcome.status}`);
  }

  if (!commit) console.log("\ndry run, nothing written. Pass --commit to apply.");
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

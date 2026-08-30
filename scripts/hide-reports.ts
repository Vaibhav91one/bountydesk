/**
 * Operator tool: soft-hide test reports so they drop off the board, the reports index and the
 * home counts, without deleting them. A real delete is impossible here (verdict and the other
 * evidence tables refuse DELETE, and report carries restrict FKs), so hiding is the only way
 * to clear leftover test rows from the lists.
 *
 * Hiding only sets report.hidden_at. readCase still loads a hidden report by id, so an
 * existing link keeps working; only the list read models filter it out.
 *
 *   node --env-file-if-exists=.env.local --import tsx scripts/hide-reports.ts <id> <id> ...
 *   node --env-file-if-exists=.env.local --import tsx scripts/hide-reports.ts --show <id> ...
 *
 * --show reverses it, clearing hidden_at back to null.
 */
import { db, inArray, report } from "@/lib/db";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const show = args.includes("--show");
  const ids = args.filter((arg) => arg !== "--show");

  if (ids.length === 0) {
    console.error("usage: hide-reports.ts [--show] <report-id> [<report-id> ...]");
    process.exit(1);
  }

  const updated = await db
    .update(report)
    .set({ hiddenAt: show ? null : new Date() })
    .where(inArray(report.id, ids))
    .returning({ id: report.id });

  console.log(`${show ? "showed" : "hid"} ${updated.length} report(s): ${updated.map((r) => r.id).join(", ") || "(none matched)"}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

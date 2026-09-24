import { selectArchivedForCleanup, type ListedSandbox } from "@/lib/sandbox/archived-sweep";
import { deleteSandbox, listSandboxes } from "@/lib/sandbox/daytona";

/**
 * Deletes archived Daytona sandboxes that BountyDesk did not create, once they are older than N
 * days. These are the harness's agent sandboxes: Daytona archives them instead of deleting them,
 * so they pile up on the account. The selection rules are in lib/sandbox/archived-sweep.ts.
 *
 *   node --env-file=.env.local --import tsx scripts/cleanup-archived-sandboxes.ts [--days 7] [--apply]
 *
 * A dry run by default: it prints what it would delete and deletes nothing without --apply.
 */
function parseArgs(argv: string[]): { days: number; apply: boolean } {
  let days = 7;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") apply = true;
    else if (argv[i] === "--days") days = Number(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return { days, apply };
}

async function main(): Promise<void> {
  const { days, apply } = parseArgs(process.argv.slice(2));

  // An empty label filter lists every sandbox on the account; the list endpoint returns labels
  // and timestamps even though the shared Sandbox type does not declare them.
  const all = (await listSandboxes({})) as unknown as ListedSandbox[];
  const selected = selectArchivedForCleanup(all, days, new Date());

  console.log(`${all.length} sandboxes, ${selected.length} archived, unlabelled and older than ${days} days`);
  for (const s of selected) {
    console.log(`  ${s.id}  updated ${s.updatedAt ?? "?"}  labels ${JSON.stringify(s.labels ?? {})}`);
  }

  if (!apply) {
    console.log("dry run, nothing deleted (pass --apply to delete)");
    return;
  }

  let failed = 0;
  for (const s of selected) {
    try {
      await deleteSandbox(s.id);
      console.log(`deleted ${s.id}`);
    } catch (error) {
      failed++;
      console.error(`failed ${s.id}: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (failed) throw new Error(`${failed} of ${selected.length} deletes failed`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

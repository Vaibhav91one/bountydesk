import { client, connectedRepository, db, eq, isNull } from "@/lib/db";
import { resolveRepositoryLineage } from "@/lib/build-onboarding/source-identity";

/**
 * Record the fork parent and root for repositories connected before onboarding started reading
 * them, so an email that links the upstream project finds the fork's target.
 *
 *   node --env-file=.env.local --import tsx scripts/backfill-repo-lineage.ts
 *
 * Only rows whose parent is still unset are read, so a re-run touches nothing it already filled.
 * A repository that is not a fork keeps nulls and is read again next time, which is harmless. It
 * uses the same anonymous GitHub read as onboarding.
 */
async function main(): Promise<void> {
  const rows = await db
    .select({ repoId: connectedRepository.repoId, fullName: connectedRepository.fullName })
    .from(connectedRepository)
    .where(isNull(connectedRepository.parentFullName));

  for (const row of rows) {
    try {
      const { parent, source } = await resolveRepositoryLineage(row.fullName);
      await db
        .update(connectedRepository)
        .set({ parentFullName: parent, sourceFullName: source, updatedAt: new Date() })
        .where(eq(connectedRepository.repoId, row.repoId));
      console.log(`${row.fullName}: parent ${parent ?? "none"}, source ${source ?? "none"}`);
    } catch (error) {
      console.error(`${row.fullName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

main().finally(() => client.end({ timeout: 5 }));

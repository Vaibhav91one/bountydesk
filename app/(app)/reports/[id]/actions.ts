"use server";

import { artifact, db, eq } from "@/lib/db";
import { requireReviewer } from "@/lib/auth/dal";
import { createSignedUrl } from "@/lib/storage/artifacts";

export type DownloadResult = { url: string } | { error: string };

/**
 * Mint a fresh, short-lived signed URL for one artifact's stored bytes.
 *
 * The URL is generated per click and never stored, because it expires. The artifact is looked up
 * by its own id (a reviewer never supplies a storage path), and a row with no stored bytes
 * returns an error the panel shows in place of a broken link. Reviewer-gated like the rest of
 * the console.
 */
export async function getArtifactDownloadUrl(artifactId: string): Promise<DownloadResult> {
  await requireReviewer();

  const [row] = await db
    .select({ storagePath: artifact.storagePath })
    .from(artifact)
    .where(eq(artifact.id, artifactId))
    .limit(1);

  if (!row) return { error: "artifact not found" };
  if (!row.storagePath) return { error: "storage not configured" };

  const url = await createSignedUrl(row.storagePath);
  if (!url) return { error: "could not generate a download link" };
  return { url };
}

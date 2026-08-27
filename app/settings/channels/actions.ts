"use server";

import { revalidatePath } from "next/cache";

import { requireReviewer } from "@/lib/auth/dal";
import { configureJuiceShopTarget } from "@/lib/targets/configure";

const FROZEN_IMAGE_DIGEST =
  "sha256:123acb31ed8bb05ebb06934a29be83d4e11a46cae937b9ed2bf2bda29d98130a";

export type ConfigureResult = { ok: true } | { ok: false; error: string };

/**
 * Bind a repository to the pinned target, which is what opens intake for it.
 *
 * requireReviewer runs first and is not decoration. A server action is a POST that reaches
 * the server on its own; the settings layout's guard runs for renders, not for this, so
 * without the call anyone who can reach the endpoint could configure a repository.
 */
export async function configureRepository(
  _previous: ConfigureResult | null,
  formData: FormData,
): Promise<ConfigureResult> {
  await requireReviewer();

  const repoId = Number(formData.get("repoId"));
  if (!Number.isSafeInteger(repoId) || repoId <= 0) {
    return { ok: false, error: "That repository id is not valid." };
  }

  try {
    await configureJuiceShopTarget({
      repoId,
      imageDigest: process.env.DAYTONA_TARGET_IMAGE_DIGEST ?? FROZEN_IMAGE_DIGEST,
      snapshotId: process.env.DAYTONA_TARGET_SNAPSHOT_ID ?? null,
    });
  } catch (error) {
    // configureJuiceShopTarget refuses a repository whose access has been withdrawn, and
    // refuses a profile whose pinned settings differ from ours. Both are worth showing the
    // operator verbatim; neither is worth a 500.
    return { ok: false, error: error instanceof Error ? error.message : "Could not configure it." };
  }

  revalidatePath("/settings/channels");
  return { ok: true };
}

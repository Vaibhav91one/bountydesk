"use server";

import { revalidatePath } from "next/cache";

import { currentSession } from "@/lib/auth/dal";
import {
  configureRepositoryRequest,
  rotateRepositoryTargetRequest,
  type ConfigureResult,
} from "@/lib/targets/configure-request";

export type { ConfigureResult };

/**
 * Bind a repository to the pinned target, which is what opens intake for it.
 *
 * Deliberately thin. A server action is a POST that reaches the server on its own, so the
 * settings layout's guard does not run for it; the authorization decision lives in
 * configureRepositoryRequest, where it is covered by tests.
 */
export async function configureRepository(
  _previous: ConfigureResult | null,
  formData: FormData,
): Promise<ConfigureResult> {
  const result = await configureRepositoryRequest(
    await currentSession(),
    formData.get("repoId"),
  );

  if (result.ok) revalidatePath("/settings/integrations");

  return result;
}

/**
 * Repoint an already-configured repository's target at a newly verified build.
 *
 * A separate action, not a branch inside configureRepository: the two calls reach different
 * mutations in lib/targets/configure (bind-or-refuse-drift versus update-in-place), and a
 * repository already bound has no path back to configureRepository's mismatch guard once a
 * verified digest actually changes.
 */
export async function rotateRepository(
  _previous: ConfigureResult | null,
  formData: FormData,
): Promise<ConfigureResult> {
  const result = await rotateRepositoryTargetRequest(
    await currentSession(),
    formData.get("repoId"),
  );

  if (result.ok) revalidatePath("/settings/integrations");

  return result;
}

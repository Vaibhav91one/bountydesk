"use server";

import { revalidatePath } from "next/cache";

import { currentSession } from "@/lib/auth/dal";
import { configureRepositoryRequest, type ConfigureResult } from "@/lib/targets/configure-request";

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

  if (result.ok) revalidatePath("/settings/channels");

  return result;
}

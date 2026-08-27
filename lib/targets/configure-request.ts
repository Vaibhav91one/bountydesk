import { isReviewer } from "@/lib/auth/reviewers";
import type { Session } from "@/lib/auth/session";

import { configureJuiceShopTarget } from "./configure";

const FROZEN_IMAGE_DIGEST =
  "sha256:123acb31ed8bb05ebb06934a29be83d4e11a46cae937b9ed2bf2bda29d98130a";

export type ConfigureResult = { ok: true } | { ok: false; error: string };

/**
 * Authorize, validate, then bind. The whole decision, in one testable place.
 *
 * The authorization check lives here rather than in the server action because a mutation
 * reachable over the network needs a test that proves an unauthorized caller changes
 * nothing, and a route handler under app/ is outside the test glob. Taking the session as
 * an argument, and re-checking it against the allowlist here, also means the caller cannot
 * skip the check by forgetting to: passing no session is a denial, not a bypass.
 *
 * Holding a valid cookie is not enough. The allowlist is consulted again because a reviewer
 * can be removed while their seven-day session is still live.
 */
export async function configureRepositoryRequest(
  session: Session | null,
  rawRepoId: unknown,
): Promise<ConfigureResult> {
  if (!session || !isReviewer(session.userId)) {
    return { ok: false, error: "You are not signed in as a reviewer." };
  }

  const repoId = Number(rawRepoId);
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
    return { ok: false, error: safeMessage(error) };
  }

  return { ok: true };
}

/**
 * Only the two failures this code raises on purpose are shown verbatim; they tell an
 * operator what to do. Anything else is a database or driver error whose message can carry
 * schema names, connection strings or row contents, and the browser is the wrong place for
 * that. The full error still reaches the server log.
 */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/is not an active connected repository/.test(message)) {
    return "That repository is not connected right now, so it cannot be configured.";
  }

  if (/different pinned target settings/.test(message)) {
    return "A target profile with that name already exists with different pinned settings. Resolve it before configuring.";
  }

  console.error("configureRepositoryRequest failed", error);
  return "Could not configure that repository. The server log has the details.";
}

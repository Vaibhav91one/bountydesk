import { isReviewer } from "@/lib/auth/reviewers";
import type { Session } from "@/lib/auth/session";

import { configureJuiceShopTarget, isValidImageDigest, isValidSnapshotId, rotateJuiceShopTarget } from "./configure";

export type ConfigureResult = { ok: true } | { ok: false; error: string };

/**
 * The checks configuring and rotating both need before they may touch the database: a
 * reviewer session, a real repository id, and a fully-configured artifact to pin against.
 * Kept in one place so the two mutations cannot drift apart on what "authorized" means.
 */
function authorizeTargetRequest(
  session: Session | null,
  rawRepoId: unknown,
):
  | { ok: true; repoId: number; imageDigest: string; snapshotId: string }
  | { ok: false; error: string } {
  if (!session || !isReviewer(session.userId)) {
    return { ok: false, error: "You are not signed in as a reviewer." };
  }

  const repoId = Number(rawRepoId);
  if (!Number.isSafeInteger(repoId) || repoId <= 0) {
    return { ok: false, error: "That repository id is not valid." };
  }

  // Both must come from an operator who has actually built and verified the connected fork.
  // Falling back to a bundled digest when they are unset would silently bind every repository
  // to whatever that fallback happened to be, which is exactly the artifact this profile is
  // supposed to pin against.
  const imageDigest = process.env.DAYTONA_TARGET_IMAGE_DIGEST;
  const snapshotId = process.env.DAYTONA_TARGET_SNAPSHOT_ID;
  if (!imageDigest || !snapshotId) {
    return { ok: false, error: "The connected-fork target is not configured yet. Set DAYTONA_TARGET_IMAGE_DIGEST and DAYTONA_TARGET_SNAPSHOT_ID first." };
  }

  // A nonempty string is not a built artifact. env.example ships both names set to explicit
  // placeholders precisely so a .env.local copied without editing them fails a shape check
  // instead of quietly passing a truthiness one and binding real repositories to nothing.
  if (!isValidImageDigest(imageDigest) || !isValidSnapshotId(snapshotId)) {
    return {
      ok: false,
      error: "DAYTONA_TARGET_IMAGE_DIGEST or DAYTONA_TARGET_SNAPSHOT_ID is still a placeholder or malformed. DAYTONA_TARGET_IMAGE_DIGEST must be sha256: followed by 64 hex characters, and DAYTONA_TARGET_SNAPSHOT_ID must be a real Daytona snapshot identifier.",
    };
  }

  return { ok: true, repoId, imageDigest, snapshotId };
}

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
  const authorized = authorizeTargetRequest(session, rawRepoId);
  if (!authorized.ok) return authorized;

  try {
    await configureJuiceShopTarget(authorized);
  } catch (error) {
    return { ok: false, error: safeMessage(error) };
  }

  return { ok: true };
}

/**
 * Repoint the pinned target profile at a new, already-verified build.
 *
 * Same reviewer gate and the same fail-closed environment read as configuring: rotating is not
 * a lesser action than the first bind, since it changes what every connected repository already
 * pointing at this profile reproduces against. There is nothing environment-specific about
 * "rotate" versus "configure" here beyond which write `lib/targets/configure` performs.
 */
export async function rotateRepositoryTargetRequest(
  session: Session | null,
  rawRepoId: unknown,
): Promise<ConfigureResult> {
  const authorized = authorizeTargetRequest(session, rawRepoId);
  if (!authorized.ok) return authorized;

  try {
    await rotateJuiceShopTarget(authorized);
  } catch (error) {
    return { ok: false, error: safeMessage(error) };
  }

  return { ok: true };
}

/**
 * The two expected domain failures are mapped to operator-facing messages. Anything else is
 * a database or driver error whose message can carry schema names, connection strings or row
 * contents, and the browser is the wrong place for that. The full error still reaches the
 * server log.
 */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/is not an active connected repository/.test(message)) {
    return "That repository is not connected right now, so it cannot be configured.";
  }

  if (/different pinned target settings/.test(message)) {
    return "A target profile with that name already exists with different pinned settings. Resolve it before configuring.";
  }

  if (/does not exist yet; nothing to rotate/.test(message)) {
    return "There is no existing target profile to rotate. Configure one first.";
  }

  console.error("configureRepositoryRequest failed", error);
  return "Could not configure that repository. The server log has the details.";
}

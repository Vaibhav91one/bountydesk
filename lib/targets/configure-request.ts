import { isReviewer } from "@/lib/auth/reviewers";
import type { Session } from "@/lib/auth/session";
import {
  and,
  connectedRepository,
  db,
  eq,
  githubInstallation,
  isNull,
  targetProfile,
} from "@/lib/db";

import {
  configureTarget,
  isValidImageDigest,
  isValidSnapshotId,
  rotateTarget,
} from "./configure";
import {
  DEFAULT_TARGET_NAME,
  envNameForTarget,
  targetDefinitionFor,
  type TargetPin,
} from "./registry";

export type ConfigureResult = { ok: true } | { ok: false; error: string };
type AuthorizedReviewerRepository = { ok: true; repoId: number } | { ok: false; error: string };

/**
 * The checks configuring and rotating both need before they may touch the database: a
 * reviewer session, a real repository id, and a fully-configured artifact to pin against.
 * Kept in one place so the two mutations cannot drift apart on what "authorized" means.
 */
function authorizeTargetRequest(
  session: Session | null,
  rawRepoId: unknown,
  rawTargetName: unknown = DEFAULT_TARGET_NAME,
):
  | ({ ok: true; repoId: number; targetName: string } & TargetPin)
  | { ok: false; error: string } {
  const authorizedRepository = authorizeReviewerRepository(session, rawRepoId);
  if (!authorizedRepository.ok) return authorizedRepository;

  const targetName = typeof rawTargetName === "string" && rawTargetName.length > 0
    ? rawTargetName
    : DEFAULT_TARGET_NAME;
  const targetDefinition = targetDefinitionFor(targetName);
  if (!targetDefinition) {
    return { ok: false, error: "That target profile is not registered." };
  }

  // Both must come from an operator who has actually built and verified the connected fork.
  // Falling back to a bundled digest when they are unset would silently bind every repository
  // to whatever that fallback happened to be, which is exactly the artifact this profile is
  // supposed to pin against.
  const targetImageDigestEnv = envNameForTarget(targetDefinition, "IMAGE_DIGEST");
  const targetSnapshotIdEnv = envNameForTarget(targetDefinition, "SNAPSHOT_ID");
  const imageDigest =
    process.env[targetImageDigestEnv] ??
    (targetName === DEFAULT_TARGET_NAME ? process.env.DAYTONA_TARGET_IMAGE_DIGEST : undefined);
  const snapshotId =
    process.env[targetSnapshotIdEnv] ??
    (targetName === DEFAULT_TARGET_NAME ? process.env.DAYTONA_TARGET_SNAPSHOT_ID : undefined);
  if (!imageDigest || !snapshotId) {
    return {
      ok: false,
      error:
        `The ${targetName} target is not configured yet. Set ${targetImageDigestEnv} and ${targetSnapshotIdEnv} first.`,
    };
  }

  // A nonempty string is not a built artifact. env.example ships both names set to explicit
  // placeholders precisely so a .env.local copied without editing them fails a shape check
  // instead of quietly passing a truthiness one and binding real repositories to nothing.
  if (!isValidImageDigest(imageDigest) || !isValidSnapshotId(snapshotId)) {
    return {
      ok: false,
      error:
        `${targetImageDigestEnv} or ${targetSnapshotIdEnv} is still a placeholder or malformed. ${targetImageDigestEnv} must be sha256: followed by 64 hex characters, and ${targetSnapshotIdEnv} must be a real Daytona snapshot identifier.`,
    };
  }

  const buildMarker = process.env[envNameForTarget(targetDefinition, "BUILD_MARKER")];
  const snapshotImageRefOverride =
    process.env[envNameForTarget(targetDefinition, "SNAPSHOT_IMAGE_REF")];

  return {
    ok: true,
    repoId: authorizedRepository.repoId,
    targetName,
    imageDigest,
    snapshotId,
    ...(buildMarker ? { buildMarker } : {}),
    ...(snapshotImageRefOverride ? { snapshotImageRefOverride } : {}),
  };
}

function authorizeReviewerRepository(
  session: Session | null,
  rawRepoId: unknown,
): AuthorizedReviewerRepository {
  if (!session || !isReviewer(session.userId)) {
    return { ok: false, error: "You are not signed in as a reviewer." };
  }

  const repoId = Number(rawRepoId);
  if (!Number.isSafeInteger(repoId) || repoId <= 0) {
    return { ok: false, error: "That repository id is not valid." };
  }

  return { ok: true, repoId };
}

async function targetNameForRotation(
  session: Session | null,
  rawRepoId: unknown,
  rawTargetName: unknown,
): Promise<
  | ({ ok: true; targetName: string } & Exclude<AuthorizedReviewerRepository, { ok: false }>)
  | { ok: false; error: string }
> {
  const authorizedRepository = authorizeReviewerRepository(session, rawRepoId);
  if (!authorizedRepository.ok) return authorizedRepository;

  if (typeof rawTargetName === "string" && rawTargetName.length > 0) {
    return { ...authorizedRepository, targetName: rawTargetName };
  }

  const [repository] = await db
    .select({ targetProfileName: targetProfile.name })
    .from(connectedRepository)
    .innerJoin(
      githubInstallation,
      eq(connectedRepository.installationId, githubInstallation.id),
    )
    .leftJoin(targetProfile, eq(connectedRepository.targetProfileId, targetProfile.id))
    .where(
      and(
        eq(connectedRepository.repoId, authorizedRepository.repoId),
        eq(connectedRepository.active, true),
        isNull(connectedRepository.archivedAt),
        isNull(githubInstallation.suspendedAt),
        isNull(githubInstallation.deletedAt),
      ),
    )
    .limit(1);

  if (!repository) {
    return {
      ok: false,
      error: "That repository is not connected right now, so it cannot be configured.",
    };
  }
  if (!repository.targetProfileName) {
    return {
      ok: false,
      error: "There is no existing target profile to rotate. Configure one first.",
    };
  }

  return { ...authorizedRepository, targetName: repository.targetProfileName };
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
  rawTargetName?: unknown,
): Promise<ConfigureResult> {
  const authorized = authorizeTargetRequest(session, rawRepoId, rawTargetName);
  if (!authorized.ok) return authorized;

  try {
    await configureTarget(authorized);
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
  rawTargetName?: unknown,
): Promise<ConfigureResult> {
  const rotationTarget = await targetNameForRotation(session, rawRepoId, rawTargetName);
  if (!rotationTarget.ok) return rotationTarget;

  const authorized = authorizeTargetRequest(session, rawRepoId, rotationTarget.targetName);
  if (!authorized.ok) return authorized;

  try {
    await rotateTarget(authorized);
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

  if (/does not match target profile/.test(message)) {
    return "That repository does not match the selected target profile.";
  }

  if (/is not bound to target profile/.test(message)) {
    return "That repository is not bound to the selected target profile.";
  }

  if (/has no expected build marker/.test(message)) {
    return "That target profile is missing its expected build marker. Set the target build marker before configuring it.";
  }

  console.error("configureRepositoryRequest failed", error);
  return "Could not configure that repository. The server log has the details.";
}

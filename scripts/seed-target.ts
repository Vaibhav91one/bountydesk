import { readFileSync } from "node:fs";
import path from "node:path";

import { configureTarget, isValidImageDigest, isValidSnapshotId } from "@/lib/targets/configure";
import { parseTargetManifest } from "@/lib/targets/manifest";
import {
  DEFAULT_TARGET_NAME,
  envNameForTarget,
  type TargetDefinition,
  targetDefinitionFor,
} from "@/lib/targets/registry";

/**
 * Bind a connected repository to a pinned target profile.
 *
 * This is the operator action the Channels screen will do once the UI exists. Intake refuses
 * any repository with no target bound, so without this nothing gets past the gate, and doing
 * it by hand in SQL is worse than doing it in a script that at least says what it did.
 *
 *   npm run seed:target -- 123456789 [target-profile-name]
 *   npm run seed:target -- 123456789 --manifest .bountydesk/target.json
 *
 * The target name defaults to Juice Shop for compatibility with the first demo path. A
 * manifest lets an onboarding agent or operator propose the same metadata without adding a new
 * hardcoded registry entry.
 */
async function main(): Promise<void> {
  const rawRepoId = process.argv[2];
  const targetSource = readTargetSource(process.argv.slice(3));
  const repoId = Number(rawRepoId);
  if (!rawRepoId || !Number.isSafeInteger(repoId) || repoId <= 0) {
    throw new Error("usage: npm run seed:target -- <github-repository-id> [target-profile-name|--manifest <path>]");
  }

  const target = targetSource.targetDefinition ?? targetDefinitionFor(targetSource.targetName);
  if (!target) throw new Error(`unknown target profile ${targetSource.targetName}`);

  const imageDigestEnv = envNameForTarget(target, "IMAGE_DIGEST");
  const snapshotIdEnv = envNameForTarget(target, "SNAPSHOT_ID");
  const buildMarkerEnv = envNameForTarget(target, "BUILD_MARKER");
  const snapshotImageRefEnv = envNameForTarget(target, "SNAPSHOT_IMAGE_REF");
  const imageDigest =
    process.env[imageDigestEnv] ??
    (targetSource.targetName === DEFAULT_TARGET_NAME
      ? process.env.DAYTONA_TARGET_IMAGE_DIGEST
      : undefined);
  const snapshotId =
    process.env[snapshotIdEnv] ??
    (targetSource.targetName === DEFAULT_TARGET_NAME
      ? process.env.DAYTONA_TARGET_SNAPSHOT_ID
      : undefined);
  if (!imageDigest || !snapshotId) {
    throw new Error(`${imageDigestEnv} and ${snapshotIdEnv} must both be set`);
  }
  if (!isValidImageDigest(imageDigest) || !isValidSnapshotId(snapshotId)) {
    throw new Error(
      `${imageDigestEnv} or ${snapshotIdEnv} is still the env.example placeholder or malformed`,
    );
  }

  const configured = await configureTarget({
    repoId,
    targetName: targetSource.targetName,
    ...(targetSource.targetDefinition ? { targetDefinition: targetSource.targetDefinition } : {}),
    imageDigest,
    snapshotId,
    ...(process.env[buildMarkerEnv] ? { buildMarker: process.env[buildMarkerEnv] } : {}),
    ...(process.env[snapshotImageRefEnv]
      ? { snapshotImageRefOverride: process.env[snapshotImageRefEnv] }
      : {}),
  });

  console.log(
    `bound ${configured.repositoryFullName} (${repoId}) to ${configured.targetProfileName}`,
  );
}

function readTargetSource(args: string[]): { targetName: string; targetDefinition?: TargetDefinition } {
  const [first, second] = args;
  if (!first) return { targetName: DEFAULT_TARGET_NAME };
  if (first === "--manifest") {
    if (!second) throw new Error("usage: npm run seed:target -- <github-repository-id> --manifest <path>");
    const targetDefinition = parseTargetManifest(
      readFileSync(path.resolve(process.cwd(), second), "utf8"),
    );
    return { targetName: targetDefinition.name, targetDefinition };
  }
  if (first.startsWith("--manifest=")) {
    const targetDefinition = parseTargetManifest(
      readFileSync(path.resolve(process.cwd(), first.slice("--manifest=".length)), "utf8"),
    );
    return { targetName: targetDefinition.name, targetDefinition };
  }
  if (second) {
    throw new Error("usage: npm run seed:target -- <github-repository-id> [target-profile-name|--manifest <path>]");
  }
  return { targetName: first };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

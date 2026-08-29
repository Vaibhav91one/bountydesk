/**
 * A second, independent proof of build identity, run from inside a live sandbox, alongside
 * (never instead of) daytona.ts's assertSnapshotImage.
 *
 * Daytona's control plane can't help here either: `GET /snapshots/{id}` only ever reports the
 * tag a snapshot was registered under, never the digest it resolved to, and `POST /api/snapshots`
 * itself refuses a digest-pinned imageName outright (confirmed live against both GHCR and a
 * plain Docker Hub image -- see PR #31's description). So the registered snapshot can only be
 * tag-pinned, and a tag can be repointed at a different image at any time: assertSnapshotImage's
 * exact-match check alone cannot prove which build actually booted.
 *
 * The build workflow (.github/workflows/build-daytona-target.yml) bakes the exact commit it
 * built into the image at a fixed path, and this reads that file back from inside the booted
 * sandbox and compares it against the commit the caller expects.
 */
import type { Sandbox } from "./daytona";
import { execute } from "./daytona";

const MARKER_PATH = "/etc/bountydesk-build-marker";

/**
 * Read the build marker baked into this sandbox's image and compare it against
 * `expectedMarker` -- e.g. lib/targets/configure.ts's EXPECTED_BUILD_MARKER -- never hardcoded
 * here, so a future rebuild from a different commit changes one constant at the call site
 * rather than this file.
 *
 * Fails closed on every path that isn't an exact match: a blank expected value, execute()
 * throwing, a non-zero exit (the file is missing, which for this image means it predates the
 * marker), or output that doesn't match byte for byte. None of those prove a mismatch, but none
 * of them prove a match either, and this function's only job is to say yes when it actually
 * read the value it expected.
 */
export async function buildMarkerCheck(sandbox: Sandbox, expectedMarker: string): Promise<boolean> {
  const expected = expectedMarker.trim();
  if (!expected) return false;

  let result;
  try {
    result = await execute(sandbox, `cat ${MARKER_PATH}`, 10);
  } catch {
    return false;
  }
  if (result.exitCode !== 0) return false;

  return result.result.trim() === expected;
}

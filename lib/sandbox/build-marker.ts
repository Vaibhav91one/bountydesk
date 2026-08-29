/**
 * A second, independent proof of build identity, run from inside a live sandbox, alongside
 * (never instead of) daytona.ts's assertSnapshotImage.
 *
 * The interim substitute docs/decisions.md anticipated for this gap is a defender-authored
 * build marker baked into the image at CI time. That turned out not to be necessary: Daytona's
 * own sandbox agent already injects DAYTONA_SANDBOX_SNAPSHOT into every sandbox it boots, of
 * the form `cr.app.daytona.io/sbox/daytona-<64 hex>:daytona`, where the hex is the resolved
 * digest of the image the snapshot was built from -- confirmed live against the pinned Juice
 * Shop snapshot, where it matched DAYTONA_TARGET_IMAGE_DIGEST byte for byte. That is exactly
 * the value assertSnapshotImage wants and cannot get: the control-plane's own
 * `GET /snapshots/{id}` only ever reports the tag a snapshot was registered under, never the
 * digest it resolved to at build time. Reading it from inside the sandbox recovers it from a
 * vantage point the control-plane call doesn't have.
 *
 * This is undocumented Daytona behaviour, the same category as reproduce.ts's per-port
 * preview-url call: not in their published API reference, confirmed by observation. It could
 * change in a future Daytona release, which is exactly why this stays a second check beside
 * assertSnapshotImage rather than a replacement for it.
 */
import type { Sandbox } from "./daytona";
import { execute } from "./daytona";

const SNAPSHOT_ENV_VAR = "DAYTONA_SANDBOX_SNAPSHOT";
const RESOLVED_DIGEST_RE = /daytona-([0-9a-f]{64})(?::|$)/i;

/**
 * Read the digest Daytona itself resolved for this sandbox's image and compare it against the
 * digest this run expects, as `input.imageDigest` already carries (`sha256:<64 hex>`) -- no new
 * field needed on ReproduceFn's input, since this is the same value assertSnapshotImage already
 * checks, just recovered from a different vantage point.
 *
 * Fails closed on every path that isn't an exact match: execute() throwing, a non-zero exit,
 * an env var that isn't there, or a value that doesn't parse. None of those prove a mismatch,
 * but none of them prove a match either, and this function's only job is to say yes when it
 * actually saw the digest it expected.
 */
export async function buildMarkerCheck(sandbox: Sandbox, expectedImageDigest: string): Promise<boolean> {
  const expectedHex = expectedImageDigest.replace(/^sha256:/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) return false;

  let result;
  try {
    result = await execute(sandbox, `printenv ${SNAPSHOT_ENV_VAR}`, 10);
  } catch {
    return false;
  }
  if (result.exitCode !== 0) return false;

  const match = RESOLVED_DIGEST_RE.exec(result.result);
  if (!match) return false;

  return match[1].toLowerCase() === expectedHex;
}

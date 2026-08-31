/**
 * Supabase Storage for artifact bytes, over the Storage REST API.
 *
 * Three calls (ensure a private bucket, upload an object, sign a download URL) done with plain
 * fetch rather than @supabase/supabase-js: adding an SDK for three requests is more surface
 * than the requests are. The service role key is a server secret and stays server-side; it is
 * read straight from the environment rather than through requireSecret so a missing key
 * degrades to a no-op instead of throwing, which is what keeps the build, the tests and a local
 * checkout with no Supabase project working.
 *
 * Every operation is best-effort: an unconfigured or unreachable Storage never throws, it
 * returns a value the caller treats as "not stored". The bucket is private, so the only way to
 * read an object back is a short-lived signed URL minted per download (see createSignedUrl); a
 * signed URL is never stored, because it expires.
 */

const BUCKET = "bountydesk-artifacts";

/** How long a download link stays valid. Long enough to click, short enough that a copied URL
 * is useless by the time it leaves the reviewer's screen. */
const SIGNED_URL_TTL_SECONDS = 300;

/**
 * Per-request timeout. Artifact recording is best-effort and runs on the publish path, so a
 * Storage endpoint that is up but slow (or a socket that never answers) must not hold that path
 * open: every request aborts here and the caller treats the abort as "not stored". Without it a
 * stalled fetch has no deadline of its own.
 */
const REQUEST_TIMEOUT_MS = 8000;

let warnedMissing = false;

type StorageConfig = { baseUrl: string; key: string };

/**
 * The Storage endpoint and service role key, or null when either is absent.
 *
 * Both are set in the deployed environment (see env.example), so null means a checkout that has
 * not filled them in rather than the expected state. The one-time log makes that visible in
 * server output without turning every artifact write into a warning. It matters more than it
 * looks: an artifact recorded while this returns null keeps storage_path null for good, because
 * the artifact table refuses UPDATE.
 */
function config(): StorageConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(
        "Supabase Storage is not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). " +
          "Artifacts are recorded without stored bytes until it is.",
      );
    }
    return null;
  }
  return { baseUrl: url.replace(/\/+$/, ""), key };
}

export function isStorageConfigured(): boolean {
  return config() !== null;
}

function authHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, apikey: key };
}

/**
 * Create the private bucket if it is not there yet, once per process.
 *
 * Memoised on the promise so concurrent uploads share one create attempt. A bucket that already
 * exists comes back as a 409/400 the caller ignores: the goal is "the bucket exists", not "this
 * call created it".
 */
let bucketReady: Promise<boolean> | null = null;

function ensureBucket(cfg: StorageConfig): Promise<boolean> {
  bucketReady ??= (async () => {
    try {
      const res = await fetch(`${cfg.baseUrl}/storage/v1/bucket`, {
        method: "POST",
        headers: { ...authHeaders(cfg.key), "Content-Type": "application/json" },
        body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // 200 created; anything else is either "already exists" (fine) or a real failure the
      // upload below will surface on its own. Never throws either way.
      return res.ok || res.status === 400 || res.status === 409;
    } catch (error) {
      console.error(
        `artifact storage: bucket ensure failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  })();
  return bucketReady;
}

/**
 * Upload one artifact's bytes to `path` within the private bucket. Returns the stored path on
 * success, or null when Storage is not configured or the upload failed. Never throws.
 *
 * x-upsert is on so a retried verdict draft that re-uploads the same deterministic path is a
 * replace, not a duplicate-key error.
 */
export async function uploadArtifact(
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string | null> {
  const cfg = config();
  if (!cfg) return null;

  await ensureBucket(cfg);

  try {
    const res = await fetch(
      `${cfg.baseUrl}/storage/v1/object/${BUCKET}/${encodeURI(path)}`,
      {
        method: "POST",
        headers: {
          ...authHeaders(cfg.key),
          "Content-Type": contentType,
          "x-upsert": "true",
        },
        body: bytes as BodyInit,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      console.error(`artifact storage: upload of ${path} failed with ${res.status}`);
      return null;
    }
    return path;
  } catch (error) {
    console.error(
      `artifact storage: upload of ${path} threw: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * A fresh signed download URL for a stored object, or null when Storage is not configured, the
 * object is missing, or signing failed. Minted per download and never persisted, because it
 * expires after SIGNED_URL_TTL_SECONDS.
 */
export async function createSignedUrl(path: string): Promise<string | null> {
  const cfg = config();
  if (!cfg) return null;

  try {
    const res = await fetch(
      `${cfg.baseUrl}/storage/v1/object/sign/${BUCKET}/${encodeURI(path)}`,
      {
        method: "POST",
        headers: { ...authHeaders(cfg.key), "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      console.error(`artifact storage: signing ${path} failed with ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { signedURL?: string };
    if (!body.signedURL) return null;
    // The API returns a path relative to /storage/v1; make it absolute so the browser can open it.
    return `${cfg.baseUrl}/storage/v1${body.signedURL}`;
  } catch (error) {
    console.error(
      `artifact storage: signing ${path} threw: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

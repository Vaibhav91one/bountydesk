import { db, eq, githubRepositoryLookup, inArray, sql } from "@/lib/db";

/**
 * GitHub's answer about public repository names, fetched anonymously at most once per expiry.
 *
 * The case file re-reads its target suggestion every five seconds, and GitHub allows 60 anonymous
 * requests an hour per IP (a Vercel IP is shared with other tenants, so often fewer). So a name is
 * fetched only by the request that claims its row, and every other poll, instance and report reads
 * the stored answer. The request budget grows with distinct names per expiry, not with polls.
 */

export type RepositoryLookup = {
  state: "pending" | "found" | "missing" | "error";
  /** GitHub's current name, which differs from the name asked about after a rename or transfer. */
  fullName: string | null;
  parentFullName: string | null;
  sourceFullName: string | null;
};

const REQUEST = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const FULL_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// A claim outlives the 5 second fetch, so a crashed claimer only delays the next try this long.
const CLAIM_SECONDS = 30;
// Renames are rare, and a stale answer costs one wrong highlight, never access.
const FOUND_SECONDS = 24 * 60 * 60;
const ERROR_SECONDS = 5 * 60;
const RATE_LIMIT_MAX_SECONDS = 60 * 60;

type Fetched = {
  state: "found" | "missing" | "error";
  fullName?: string | null;
  parentFullName?: string | null;
  sourceFullName?: string | null;
  seconds: number;
};

/**
 * The stored answer for each name, keyed by its lowercased form, after fetching the ones whose
 * answer has expired. `missingSeconds` is how long a 404 is believed: long for a name a report
 * linked, short for a fork a reviewer is about to create.
 */
export async function lookupRepositories(
  names: string[],
  opts: { missingSeconds: number; fetchImpl?: typeof fetch },
): Promise<Map<string, RepositoryLookup>> {
  const keys = [...new Set(names.map((name) => name.toLowerCase()))].filter(
    (name) => REQUEST.test(name) && !/^\.+$/.test(name.split("/")[1]),
  );
  if (keys.length === 0) return new Map();

  // One statement claims every name nobody holds a fresh answer for. A conflicting row is only
  // claimed once expired, and a claimed row keeps its old answer readable while it is refreshed.
  // It commits before any fetch, so no lock is held across the network.
  const claimUntil = sql`now() + make_interval(secs => ${CLAIM_SECONDS})`;
  const claimed = await db
    .insert(githubRepositoryLookup)
    .values(keys.map((name) => ({ name, state: "pending", expiresAt: claimUntil })))
    .onConflictDoUpdate({
      target: githubRepositoryLookup.name,
      set: { expiresAt: claimUntil },
      setWhere: sql`${githubRepositoryLookup.expiresAt} <= now()`,
    })
    .returning({ name: githubRepositoryLookup.name });

  await Promise.all(
    claimed.map(async ({ name }) => {
      const fetched = await fetchRepository(name, opts.fetchImpl ?? fetch, opts.missingSeconds);
      const expiresAt = sql`now() + make_interval(secs => ${fetched.seconds})`;
      await db
        .update(githubRepositoryLookup)
        .set(
          fetched.state === "error"
            ? // A failed refresh keeps the last good answer and only backs off.
              {
                state: sql`case when ${githubRepositoryLookup.state} = 'pending' then 'error' else ${githubRepositoryLookup.state} end`,
                expiresAt,
                updatedAt: sql`now()`,
              }
            : {
                state: fetched.state,
                fullName: fetched.fullName ?? null,
                parentFullName: fetched.parentFullName ?? null,
                sourceFullName: fetched.sourceFullName ?? null,
                expiresAt,
                updatedAt: sql`now()`,
              },
        )
        .where(eq(githubRepositoryLookup.name, name));
    }),
  );

  const rows = await db
    .select({
      name: githubRepositoryLookup.name,
      state: githubRepositoryLookup.state,
      fullName: githubRepositoryLookup.fullName,
      parentFullName: githubRepositoryLookup.parentFullName,
      sourceFullName: githubRepositoryLookup.sourceFullName,
    })
    .from(githubRepositoryLookup)
    .where(inArray(githubRepositoryLookup.name, keys));
  return new Map(rows.map(({ name, ...lookup }) => [name, lookup as RepositoryLookup]));
}

async function fetchRepository(name: string, fetchImpl: typeof fetch, missingSeconds: number): Promise<Fetched> {
  let response: Response;
  try {
    // fetch follows GitHub's 301 for a renamed or transferred repository, so full_name below is
    // the current name. The host is fixed, and the path is a validated owner/repo.
    response = await fetchImpl(`https://api.github.com/repos/${name}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "bountydesk-target-suggest",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { state: "error", seconds: ERROR_SECONDS };
  }
  if (response.status === 404) return { state: "missing", seconds: missingSeconds };
  if (response.status === 403 || response.status === 429) {
    return { state: "error", seconds: rateLimitSeconds(response.headers) };
  }
  if (!response.ok) return { state: "error", seconds: ERROR_SECONDS };

  let repo: { full_name?: unknown; fork?: unknown; parent?: { full_name?: unknown }; source?: { full_name?: unknown } };
  try {
    repo = await response.json();
  } catch {
    return { state: "error", seconds: ERROR_SECONDS };
  }
  const valid = (value: unknown) => (typeof value === "string" && FULL_NAME.test(value) ? value : null);
  const fullName = valid(repo.full_name);
  if (!fullName) return { state: "error", seconds: ERROR_SECONDS };
  const fork = repo.fork === true;
  return {
    state: "found",
    fullName,
    parentFullName: fork ? valid(repo.parent?.full_name) : null,
    sourceFullName: fork ? valid(repo.source?.full_name) : null,
    seconds: FOUND_SECONDS,
  };
}

/** Wait out GitHub's own reset rather than spend more of an exhausted budget. */
function rateLimitSeconds(headers: Headers): number {
  const retryAfter = Number(headers.get("retry-after"));
  const reset = Number(headers.get("x-ratelimit-reset")) - Math.floor(Date.now() / 1000);
  const wait = retryAfter > 0 ? retryAfter : reset > 0 ? reset : ERROR_SECONDS;
  return Math.min(Math.max(wait, 60), RATE_LIMIT_MAX_SECONDS);
}

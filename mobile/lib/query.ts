/**
 * TanStack Query with a persisted cache.
 *
 * The cache is persisted to AsyncStorage so the app reads cached data for
 * offline viewing: a cold launch shows the last-seen report list before any
 * network request. Mutations are NOT queued while offline — they keep
 * networkMode: "online" so a failed mutation surfaces to the UI immediately.
 *
 * The cache blob is namespaced per signed-in Clerk user (see makePersister),
 * so a different reviewer on the same phone never hydrates the previous
 * reviewer's reports.
 */
import { QueryClient } from "@tanstack/react-query"
import { Persister } from "@tanstack/react-query-persist-client"
import AsyncStorage from "@react-native-async-storage/async-storage"

export const CACHE_KEY_BASE = "tanstack-query:bountydesk"

export function cacheKeyForUser(userId: string | null): string {
  return userId ? `${CACHE_KEY_BASE}:${userId}` : CACHE_KEY_BASE
}

// Kept so signOutAndClear() — which runs outside React and the provider's
// lifetime — can target the currently-mounted client and its storage key when
// Clerk ends a session on its own (token expiry, server revoke). QueryProvider
// owns the real client, created per user; this ref just lets the teardown
// reach it.
let currentUserId: string | null = null
let activeClient: QueryClient | null = null
export function currentCacheKey(): string {
  return cacheKeyForUser(currentUserId)
}
export function setCacheUser(userId: string | null | undefined): string | null {
  const prev = currentUserId
  currentUserId = userId ?? null
  return prev
}
export function setActiveClient(client: QueryClient | null): void {
  activeClient = client ?? null
}
export function getActiveClient(): QueryClient | null {
  return activeClient
}

/**
 * Build a QueryClient with the app's defaults. A fresh client per user is what
 * lets QueryProvider isolate one reviewer's in-memory cache from the next: Clerk
 * can end a session on its own (token expiry, server revoke), and without a
 * per-user client that in-memory state would leak to whoever signs in next on
 * a shared device.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000 * 60 * 2, // 2 minutes
        gcTime: 1000 * 60 * 30, // 30 minutes
        retry: (failureCount, _error) => failureCount < 3,
      },
      mutations: {
        // Never queue offline; fail fast so the caller can show an error.
        retry: false,
        networkMode: "online",
      },
    },
  })
}

/**
 * Build a persister that reads/writes AsyncStorage under a key scoped to the
 * given Clerk user id. This is the single source of truth for the on-disk cache
 * key, used by QueryProvider so the restore happens against the correct user
 * before any child effect runs.
 *
 * Pass null for a signed-out session: the returned persister is still valid but
 * will not find a blob (there never is one while signed out), and callers that
 * render the provider keyed by `userId ?? "signed-out"` remount cleanly on
 * sign-in/sign-out.
 */
export function makePersister(userId: string | null): Persister {
  const key = cacheKeyForUser(userId)
  return {
    persistClient: async (client) => {
      const value = JSON.stringify(client)
      await AsyncStorage.setItem(key, value)
    },
    restoreClient: async () => {
      const value = await AsyncStorage.getItem(key)
      if (!value) return undefined
      try {
        return JSON.parse(value) as ReturnType<typeof JSON.parse> & { buster: string; clientState: unknown }
      } catch {
        return undefined
      }
    },
    removeClient: async () => {
      await AsyncStorage.removeItem(key)
    },
  }
}

/**
 * Default persister for the signed-out session. Kept for callers that do not have
 * a user id yet; QueryProvider passes a real one when the user is signed in.
 */
export const asyncStoragePersister: Persister = makePersister(null)

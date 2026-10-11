/**
 * TanStack Query with a persisted cache.
 *
 * The cache is persisted to AsyncStorage so the app reads cached data for
 * offline viewing: a cold launch shows the last-seen report list before any
 * network request. Mutations are NOT queued while offline — they keep
 * networkMode: "online" so a failed mutation surfaces to the UI immediately.
 */
import { QueryClient } from "@tanstack/react-query"
import { Persister } from "@tanstack/react-query-persist-client"
import AsyncStorage from "@react-native-async-storage/async-storage"

export const CACHE_KEY_BASE = "tanstack-query:bountydesk"

// The cache blob is namespaced per signed-in Clerk user so a different reviewer
// on the same phone never hydrates another reviewer's last-seen data. The user
// id is set by ClerkTokenBridge on mount via setCacheUser().
let currentUserId: string | null = null
export function cacheKeyForUser(userId: string | null): string {
  return userId ? `${CACHE_KEY_BASE}:${userId}` : CACHE_KEY_BASE
}
export function currentCacheKey(): string {
  return cacheKeyForUser(currentUserId)
}
export function setCacheUser(userId: string | null | undefined): string | null {
  const prev = currentUserId
  currentUserId = userId ?? null
  return prev
}

export const queryClient = new QueryClient({
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

/**
 * A Persister backed by AsyncStorage. The PersistQueryClientProvider subscribes
 * to cache changes and writes the whole client state as one JSON blob.
 *
 * The storage key is user-scoped (see setCacheUser), so signing in as a
 * different reviewer starts from an empty cache instead of hydrating the
 * previous reviewer's reports.
 */
export const asyncStoragePersister: Persister = {
  persistClient: async (client) => {
    const value = JSON.stringify(client)
    await AsyncStorage.setItem(currentCacheKey(), value)
  },
  restoreClient: async () => {
    const value = await AsyncStorage.getItem(currentCacheKey())
    if (!value) return undefined
    try {
      return JSON.parse(value) as ReturnType<typeof JSON.parse> & { buster: string; clientState: unknown }
    } catch {
      return undefined
    }
  },
  removeClient: async () => {
    await AsyncStorage.removeItem(currentCacheKey())
  },
}

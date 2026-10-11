/**
 * Reviewer session teardown.
 *
 * Signing out is not just a Clerk call: the persisted TanStack Query cache
 * (AsyncStorage) holds the last reviewer's reports, and on a shared device the
 * next reviewer would hydrate them (and, offline, read them) before any
 * network request. signOutAndClear() tears the local cache down first, then
 * hands control to Clerk.
 *
 * The cache key is also user-scoped (see lib/query.ts), so even a fresh launch
 * never cross-loads between accounts — this is the belt to that brace.
 */
import AsyncStorage from "@react-native-async-storage/async-storage"

import { asyncStoragePersister, currentCacheKey, getActiveClient } from "./query"

/**
 * Clears the in-memory and persisted query cache, then signs the Clerk session
 * out. Every sign-out path (the explicit "Sign out" button on M3, the 401
 * auto-sign-out from useApiQuery, and any future explicit flow) goes through
 * here so the previous reviewer's data is never visible to the next one.
 *
 * `signOut` is passed in by the caller because it comes from Clerk's useAuth
 * hook, which can only run in a React component. This keeps session.ts free of
 * React primitives so it is trivially unit-testable.
 */
export async function signOutAndClear(signOut: () => Promise<unknown>): Promise<void> {
  const client = getActiveClient()
  if (client) {
    // Stop any in-flight refetches first so they are not persisted after clear().
    client.cancelQueries({ type: "all" })
    // Drop the in-memory cache immediately.
    client.clear()
  }
  // Remove the persisted blob from AsyncStorage. removeClient is a no-op if
  // the key is already absent.
  await asyncStoragePersister.removeClient?.()
  // Belt-and-suspenders: clear any stray storage write that raced with clear().
  await AsyncStorage.removeItem(currentCacheKey())
  // Finally, end the Clerk session.
  await signOut()
}

/**
 * Wraps the app in the TanStack Query client with a persisted cache.
 *
 * The PersistQueryClientProvider restores from AsyncStorage on first paint
 * (offline viewing: a cold launch shows the last-seen report list) and writes
 * every cache change back to AsyncStorage. The cache is capped at 24 hours.
 * Queries use staleTime so cached data renders immediately and refetches in
 * the background; mutations are online-only and never queued while offline,
 * so a failed write surfaces to the UI instead of silently replaying.
 *
 * The cache is namespaced per Clerk user id: the provider is keyed by
 * `userId ?? "signed-out"` and builds its persister from that id, so it
 * remounts and restores the correct blob on every sign-in/sign-out. Deriving
 * the key here (in render, before any child effect runs) is what lets a
 * signed-in reviewer see their own cached reports and never another
 * reviewer's.
 */
import { ReactNode } from "react"
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client"

import { queryClient, makePersister, setCacheUser } from "@/lib/query"

export function QueryProvider({
  children,
  userId,
}: {
  children: ReactNode
  userId: string | null | undefined
}) {
  // Mirror the active user into the module-level key used by signOutAndClear()
  // (which runs outside the provider's lifetime). Doing it here, in render,
  // means the key is current before PersistQueryClientProvider's own restore
  // effect fires — the child-effect ordering bug is avoided entirely.
  setCacheUser(userId)
  const persister = makePersister(userId ?? null)

  return (
    <PersistQueryClientProvider
      // key changes per user so React remounts and re-restores the right cache
      // on sign-in and sign-out, rather than reusing a stale one.
      key={userId ?? "signed-out"}
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 1000 * 60 * 60 * 24, // 24 hours
      }}
    >
      {children}
    </PersistQueryClientProvider>
  )
}

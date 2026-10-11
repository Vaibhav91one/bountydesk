/**
 * Wraps the app in the TanStack Query client with a persisted cache.
 *
 * The PersistQueryClientProvider restores from AsyncStorage on first paint
 * (offline viewing: a cold launch shows the last-seen report list) and writes
 * every cache change back to AsyncStorage. The cache is capped at 24 hours.
 * Queries use staleTime so cached data renders immediately and refetches in
 * the background; mutations are online-only and never queued while offline,
 * so a failed write surfaces to the UI instead of silently replaying.
 */
import { ReactNode } from "react"
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client"

import { queryClient, asyncStoragePersister } from "@/lib/query"

export function QueryProvider({ children }: { children: ReactNode }) {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: asyncStoragePersister,
        // The persister keys itself under CACHE_KEY (see lib/query.ts).
        maxAge: 1000 * 60 * 60 * 24, // 24 hours
      }}
    >
      {children}
    </PersistQueryClientProvider>
  )
}

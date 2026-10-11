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
 * A brand-new QueryClient is created per user id (and for the signed-out
 * state). This is the in-memory counterpart to the user-scoped storage key in
 * lib/query-clients.ts: Clerk can end a session on its own (token expiry, server
 * revoke), and a singleton client would leak the previous reviewer's cached
 * reports into the next reviewer's session. When the client changes, the
 * previous one is cleared, and the module-level ref (read by signOutAndClear)
 * is updated synchronously in render so the storage key it uses is correct.
 */
import { ReactNode, useMemo } from "react"
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client"

import { getClientForUser } from "@/lib/query-clients"
import { makePersister } from "@/lib/query"

export function QueryProvider({
  children,
  userId,
}: {
  children: ReactNode
  userId: string | null | undefined
}) {
  // getClientForUser returns the same client for the same user and clears the
  // old one when the user changes (incl. sign-out -> null). It also mirrors the
  // active user into the module-level key in lib/query.ts (read by
  // signOutAndClear, which runs outside React) and registers the live client,
  // so teardown always targets the right cache and storage key — and it does
  // so synchronously in render, before PersistQueryClientProvider's own
  // restore effect fires, avoiding the child-effect ordering bug entirely.
  const client = getClientForUser(userId ?? null)

  const persister = useMemo(() => makePersister(userId ?? null), [userId])

  return (
    <PersistQueryClientProvider
      // key changes per user so React remounts and re-restores the right cache
      // on sign-in and sign-out, rather than reusing a stale one.
      key={userId ?? "signed-out"}
      client={client}
      persistOptions={{
        persister,
        maxAge: 1000 * 60 * 60 * 24, // 24 hours
      }}
    >
      {children}
    </PersistQueryClientProvider>
  )
}

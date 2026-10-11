/**
 * Per-user in-memory QueryClient isolation.
 *
 * Why this is a separate, React-free module: the "clear the previous user's
 * cache on switch" decision has to happen in plain synchronous code so it is
 * deterministic and trivially testable without rendering React. QueryProvider
 * (the render layer) just calls getClientForUser and hands the result to
 * PersistQueryClientProvider; that module owns the swap logic.
 *
 * Clerk can end a session on its own (token expiry, server revoke) and flip
 * isSignedIn false without an explicit signOut. A singleton client would then
 * leak the previous reviewer's in-memory reports into the next reviewer's
 * session on a shared device. This module solves that by keeping one current
 * client keyed by userId and clearing the old one whenever the user changes.
 */
import { QueryClient } from "@tanstack/react-query"

import { createQueryClient, setActiveClient, setCacheUser } from "./query"

let currentUserId: string | null = null
let activeClient: QueryClient | null = null

/**
 * Return the QueryClient for the given user id, creating and installing a fresh
 * one when the user changes (including transitions to/from the signed-out
 * `null` state). When switching away from a previous user, the old client's
 * in-memory cache is cleared first so nothing leaks across sessions on a shared
 * device.
 *
 * Also mirrors the active user into the module-level key in lib/query.ts
 * (read by signOutAndClear, which runs outside React) and registers the live
 * client there, so teardown always targets the right cache and storage key.
 */
export function getClientForUser(userId: string | null): QueryClient {
  const resolved = userId ?? null
  setCacheUser(resolved)
  if (activeClient && currentUserId === resolved) {
    setActiveClient(activeClient)
    return activeClient
  }
  // Different user (sign-in, sign-out, or switch account): tear down the old
  // cache before installing the new one.
  if (activeClient) {
    activeClient.clear()
  }
  const client = createQueryClient()
  activeClient = client
  currentUserId = resolved
  setActiveClient(client)
  return client
}

/**
 * The currently-mounted client, for teardown paths that run outside React
 * (e.g. signOutAndClear in lib/session.ts).
 */
export function currentClient(): QueryClient | null {
  return activeClient
}

/**
 * Reset the tracked user/client. Primarily for test isolation so one test's
 * cached client does not bleed into the next.
 */
export function _resetClientForUser(): void {
  activeClient = null
  currentUserId = null
  setActiveClient(null)
}

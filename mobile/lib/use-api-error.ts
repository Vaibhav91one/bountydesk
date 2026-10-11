import { useRouter } from "expo-router"
import { useAuth } from "@clerk/expo"
import { useCallback } from "react"

import { ApiError } from "./api"
import { signOutAndClear } from "./session"

/**
 * Returns a stable callback that turns an api() failure into a UI action.
 *
 * - 401: the Clerk token is good but the session is stale, so sign the user out
 *   and clear the persisted query cache (see lib/session.ts).
 * - 403: the signed-in reviewer is valid but not allowlisted, so send them to the
 *   not-authorized screen. Any other caller decides what to do with the error.
 *
 * api() stays a plain, hook-free function; this hook is the one place the mobile shell
 * reaches for Clerk and the router together. The callback is memoized so consumers can
 * depend on a stable reference without re-triggering effects on every render.
 */
export function useHandleApiError(): (e: unknown) => void {
  const router = useRouter()
  const { signOut } = useAuth()

  return useCallback((e: unknown) => {
    if (!(e instanceof ApiError)) return

    if (e.status === 401) {
      // Clear the reviewer's cached reports, then end the Clerk session.
      // Fire-and-forget: the navigation reset to /auth/splash happens via the
      // Clerk session change, not here. Guard the promise so a sync mock in a
      // test can't crash the effect.
      const p = signOutAndClear(() => signOut())
      if (p && typeof p.catch === "function") p.catch(() => {})
      return
    }

    if (e.status === 403) {
      router.replace("/auth/not-authorized")
    }
  }, [router, signOut])
}

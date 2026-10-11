import { useRouter } from "expo-router"
import { useAuth } from "@clerk/clerk-expo"

import { ApiError } from "./api"

/**
 * Returns a callback that turns an api() failure into a UI action.
 *
 * - 401: the Clerk token is good but the session is stale, so sign the user out.
 * - 403: the signed-in reviewer is valid but not allowlisted, so send them to the
 *   not-authorized screen. Any other caller decides what to do with the error.
 *
 * api() stays a plain, hook-free function; this hook is the one place the mobile shell
 * reaches for Clerk and the router together.
 */
export function useHandleApiError(): (e: unknown) => void {
  const router = useRouter()
  const { signOut } = useAuth()

  return (e: unknown) => {
    if (!(e instanceof ApiError)) return

    if (e.status === 401) {
      signOut()
      return
    }

    if (e.status === 403) {
      router.replace("/auth/not-authorized")
    }
  }
}

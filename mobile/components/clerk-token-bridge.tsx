import { ReactNode, useEffect } from "react"
import { useAuth } from "@clerk/expo"

import { setTokenGetter } from "@/lib/api"
import { setCacheUser } from "@/lib/query"

/**
 * Wires the Clerk session token into the API client. This runs once inside the
 * ClerkProvider so useAuth is valid. Every api() call reads the live token at
 * request time, so a session change is reflected without a restart.
 *
 * api() stays a plain, hook-free function; this is the one place it reaches for Clerk.
 */
export function ClerkTokenBridge({ children }: { children: ReactNode }) {
  const { getToken, userId } = useAuth()

  useEffect(() => {
    setCacheUser(userId)
    setTokenGetter(async () => {
      try {
        return await getToken()
      } catch {
        return null
      }
    })
  }, [getToken, userId])

  return <>{children}</>
}

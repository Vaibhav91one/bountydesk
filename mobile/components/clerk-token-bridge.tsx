import { ReactNode, useEffect } from "react"
import { useAuth } from "@clerk/clerk-expo"

import { setTokenGetter } from "@/lib/api"

/**
 * Wires the Clerk session token into the API client. This runs once inside the
 * ClerkProvider so useAuth is valid. Every api() call reads the live token at
 * request time, so a session change is reflected without a restart.
 */
export function ClerkTokenBridge({ children }: { children: ReactNode }) {
  const { getToken } = useAuth()

  useEffect(() => {
    setTokenGetter(async () => {
      try {
        return await getToken()
      } catch {
        return null
      }
    })
  }, [getToken])

  return <>{children}</>
}

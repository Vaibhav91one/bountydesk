/**
 * Bridges Clerk into the rest of the app. Two jobs:
 *
 * 1. Wires the Clerk session token into the API client (api()) so every
 *    fetch can attach the bearer header without each caller importing Clerk.
 *    api() stays a plain, hook-free function; this is the one place it reaches
 *    for Clerk.
 *
 * 2. Renders QueryProvider, forwarding the signed-in user id. The user id must
 *    reach QueryProvider synchronously (in render), not via a child effect:
 *    PersistQueryClientProvider restores its cache in its own mount effect, and
 *    child effects run AFTER that — so setting the cache key in a child effect
 *    would restore the wrong (signed-out) blob. Passing userId as a prop lets
 *    QueryProvider derive the user-scoped key before its restore effect fires,
 *    and the provider is keyed by userId so it remounts and re-restores on
 *    every sign-in/sign-out.
 */
import { ReactNode, useEffect } from "react"
import { useAuth } from "@clerk/expo"

import { QueryProvider } from "@/components/QueryProvider"
import { setTokenGetter } from "@/lib/api"

export function ClerkTokenBridge({ children }: { children: ReactNode }) {
  const { getToken, isLoaded, userId } = useAuth()

  useEffect(() => {
    setTokenGetter(async () => {
      try {
        return await getToken()
      } catch {
        return null
      }
    })
  }, [getToken])

  // Until Clerk resolves the session we don't know the user id, so we must not
  // mount the persisted cache — otherwise the signed-out key is used and a
  // signed-in reviewer's reports are never restored.
  if (!isLoaded) {
    return <>{children}</>
  }

  return (
    <QueryProvider userId={userId}>
      {children}
    </QueryProvider>
  )
}

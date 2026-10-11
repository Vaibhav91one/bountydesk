/**
 * Signed-out flow. When there is no session, the slot renders splash, sign-in,
 * or not-authorized. As soon as a session resolves we redirect toward the
 * signed-in tab shell — but only from splash and sign-in. A signed-in reviewer
 * on /auth/not-authorized has just failed the server allowlist (403), so
 * bouncing them to /tabs would re-run /home, 403 again, and loop back here
 * forever. authRedirect keeps them on not-authorized.
 */
import { useAuth } from "@clerk/expo"
import { Redirect, Stack, useSegments } from "expo-router"

import { authRedirect } from "@/lib/auth"

export default function AuthLayout() {
  const { isLoaded, isSignedIn } = useAuth()
  const segments = useSegments()

  if (!isLoaded) {
    return null
  }

  const redirect = authRedirect(segments, !!isSignedIn)
  if (redirect) {
    return <Redirect href={redirect as "/(tabs)"} />
  }

  return <Stack screenOptions={{ headerShown: false, animation: "none" }} />
}

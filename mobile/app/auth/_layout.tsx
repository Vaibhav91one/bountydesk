/**
 * Signed-out flow. When there is no session, the slot renders splash, sign-in,
 * or not-authorized. As soon as a session resolves we redirect to the signed-in
 * tab shell.
 */
import { useAuth } from "@clerk/clerk-expo"
import { Redirect, Stack } from "expo-router"

export default function AuthLayout() {
  const { isLoaded, isSignedIn } = useAuth()

  if (!isLoaded) {
    return null
  }

  if (isSignedIn) {
    return <Redirect href="/(tabs)" />
  }

  return <Stack screenOptions={{ headerShown: false, animation: "none" }} />
}

/** M0 Entry. Sends signed-in users to the tabs and signed-out users to the splash. */
import { Redirect } from "expo-router"
import { useAuth } from "@clerk/expo"

export default function IndexScreen() {
  const { isLoaded, isSignedIn } = useAuth()

  if (!isLoaded) {
    return null
  }

  if (isSignedIn) {
    return <Redirect href="/(tabs)" />
  }

  return <Redirect href="/auth/splash" />
}

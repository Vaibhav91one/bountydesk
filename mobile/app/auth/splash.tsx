/** M1 Splash. Shown to signed-out users, then advances to sign-in after the design's 1600ms.
 * Signed-in users never get here: the auth layout sends them to the tabs. */
import { useEffect } from "react"
import { useRouter } from "expo-router"

import { SplashView } from "@/components/SplashView"
import { useAuth } from "@/lib/auth-hooks"

export default function SplashScreen() {
  const router = useRouter()
  const { isLoaded, isSignedIn } = useAuth()

  useEffect(() => {
    if (!isLoaded || isSignedIn) return
    const timeout = setTimeout(() => router.replace("/auth/sign-in"), 1600)
    return () => clearTimeout(timeout)
  }, [isLoaded, isSignedIn, router])

  return <SplashView />
}

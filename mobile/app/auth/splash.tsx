/** M1 Splash. Brand surface shown while the session check resolves; advances to sign-in. */
import { useEffect } from "react"
import { View, Text, StyleSheet } from "react-native"
import { useRouter } from "expo-router"
import { useAuth } from "@clerk/expo"

export default function SplashScreen() {
  const router = useRouter()
  const { isLoaded } = useAuth()

  useEffect(() => {
    // Wait for Clerk to finish hydrating, then hand off. A signed-in user never
    // reaches this screen (the auth group redirects them to tabs), so once loaded
    // we always go to sign-in.
    if (!isLoaded) return

    const t = setTimeout(() => {
      router.replace("/auth/sign-in")
    }, 1200)
    return () => clearTimeout(t)
  }, [isLoaded, router])

  return (
    <View style={styles.container}>
      <View style={styles.surface}>
        <Text style={styles.wordmark}>BountyDesk</Text>
        <Text style={styles.tagline}>Security triage, reviewer-first.</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1a1a1f",
    alignItems: "center",
    justifyContent: "center",
  },
  surface: {
    alignItems: "center",
    gap: 16,
  },
  wordmark: {
    fontSize: 48,
    fontWeight: "800",
    letterSpacing: -2,
    color: "#ffffff",
  },
  tagline: {
    fontSize: 17,
    color: "#919199",
    letterSpacing: 0.3,
  },
})

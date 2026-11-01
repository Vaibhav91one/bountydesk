/** M3 Not authorized. Shown when GET /me returns allowlisted: false.
 * Matches docs/site/screens/m3.html exactly:
 * An EmptyState (out-of-scope mascot, heading, body, "Request access") with a ghost "Sign out" below.
 */
import { View, Text, TouchableOpacity, StyleSheet, Alert } from "react-native"
import { EmptyState } from "@/components/primitives"
import { useRouter } from "expo-router"
import { useAuth } from "@/lib/auth-hooks"

import { signOutAndClear } from "@/lib/session"
import { darkTheme } from "@/theme"

export default function NotAuthorizedScreen() {
  const router = useRouter()
  const { signOut } = useAuth()
  const t = darkTheme

  const handleRequestAccess = () => {
    // In c.js: data-toast="Access requested"
    Alert.alert("Access requested")
  }

  const handleSignOut = async () => {
    await signOutAndClear(() => signOut())
    router.replace("/auth/sign-in")
  }

  return (
    <View style={[styles.container, { backgroundColor: t.colors.background }]}>
      <EmptyState
        mascot="out-of-scope"
        heading="You are not on the reviewer allowlist"
        body="Your account signed in, but only allowlisted reviewers can open reports and sign verdicts. Ask an owner to add your email address."
        action={{ title: "Request access", onPress: handleRequestAccess }}
      />
      <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={handleSignOut} activeOpacity={0.9}>
        <Text style={[styles.btnTextGhost, { color: t.colors["brand-soft"] }]}>Sign out</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 40, paddingTop: 120 },
  btn: {
    minHeight: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 22,
    alignSelf: "center",
  },
  btnGhost: {
    backgroundColor: "transparent",
  },
  btnTextGhost: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: -0.187,
  },
})

/** M3 Not authorized. Shown when GET /me returns allowlisted: false.
 * Matches docs/site/screens/m3.html exactly:
 * - out-of-scope mascot (200x200)
 * - h1 "You are not on the reviewer allowlist"
 * - body text mentioning alex@example.com
 * - "Request access" (primary) and "Sign out" (ghost) buttons
 *
 * m3-actions has a 22px gap, margin-top 22px, max-width 300px.
 */
import { View, Text, TouchableOpacity, StyleSheet, useColorScheme, Alert, Image } from "react-native"
import { useRouter } from "expo-router"
import { useAuth } from "@clerk/expo"

import { signOutAndClear } from "@/lib/session"
import { darkTheme, lightTheme } from "@/theme"

export default function NotAuthorizedScreen() {
  const router = useRouter()
  const { signOut } = useAuth()
  const cs = useColorScheme()
  const t = cs === "dark" ? darkTheme : lightTheme

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
      <View style={styles.empty}>
        <Image source={require("../../assets/brand/mascot-png/out-of-scope.png")} style={{ width: 200, height: 200, marginTop: -5, marginBottom: 5 }} />
        <Text style={[styles.title, { color: t.colors.foreground }]}>
          You are not on the reviewer allowlist
        </Text>
        <Text style={[styles.body, { color: t.colors.muted }]}>
          Your account signed in, but only allowlisted reviewers can open reports and sign
          verdicts. Ask an owner to add alex@example.com.
        </Text>
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.btn, styles.btnPrimary, { backgroundColor: t.colors.brand }]}
            onPress={handleRequestAccess}
          >
            <Text style={styles.btnTextPrimary}>Request access</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, styles.btnGhost]}
            onPress={handleSignOut}
            activeOpacity={0.9}
          >
            <Text style={[styles.btnTextGhost, { color: t.colors["brand-soft"] }]}>Sign out</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingTop: 200,
    paddingHorizontal: 40,
  },
  empty: {
    alignItems: "center",
    alignSelf: "stretch",
  },
  title: {
    fontSize: 24, // 1.5rem in c.css .empty h1
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.72,
    lineHeight: 28.8,
    textAlign: "center",
    marginTop: 18,
  },
  body: {
    fontSize: 15, // .9375rem in c.css
    fontFamily: "Inter_400Regular",
    lineHeight: 21.75,
    textAlign: "center",
    maxWidth: 300,
    marginTop: 10,
  },
  actions: {
    flexDirection: "column",
    gap: 6,
    // Full width up to the mockup's 300pt, so a 375pt phone still fits inside the 40pt gutters.
    width: "100%",
    maxWidth: 300,
    marginTop: 22,
  },
  btn: {
    minHeight: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 22,
  },
  btnPrimary: {},
  btnTextPrimary: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: -0.187,
    color: "#ffffff",
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

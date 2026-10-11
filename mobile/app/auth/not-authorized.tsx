/** M3 Not authorized. Shown when GET /me returns allowlisted: false.
 * Matches docs/site/screens/m3.html exactly:
 * - out-of-scope mascot (200x200)
 * - h1 "You are not on the reviewer allowlist"
 * - body text mentioning alex@example.com
 * - "Request access" (primary) and "Sign out" (ghost) buttons
 *
 * m3-actions has a 22px gap, margin-top 22px, max-width 300px.
 */
import { View, Text, TouchableOpacity, StyleSheet, useColorScheme } from "react-native"
import { useRouter } from "expo-router"
import { useAuth } from "@clerk/expo"

import { SvgAsset } from "@/components/SvgImage"
import { darkTheme, lightTheme } from "@/theme"

export default function NotAuthorizedScreen() {
  const router = useRouter()
  const { signOut } = useAuth()
  const cs = useColorScheme()
  const t = cs === "dark" ? darkTheme : lightTheme

  const handleRequestAccess = () => {
    // In c.js: data-toast="Access requested"
    alert("Access requested")
  }

  const handleSignOut = async () => {
    await signOut()
    router.replace("/auth/sign-in")
  }

  return (
    <View style={[styles.container, { backgroundColor: t.colors.background }]}>
      <View style={styles.empty}>
        <SvgAsset name="mascot/out-of-scope" width={200} height={200} />
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
    justifyContent: "center",
  },
  empty: {
    alignItems: "center",
    gap: 18,
    paddingBottom: 40,
  },
  title: {
    fontSize: 24, // 1.5rem in c.css .empty h1
    fontWeight: "700",
    letterSpacing: -0.5,
    lineHeight: 29,
    textAlign: "center",
  },
  body: {
    fontSize: 15, // .9375rem in c.css
    lineHeight: 23,
    textAlign: "center",
    maxWidth: 300,
  },
  actions: {
    flexDirection: "column",
    gap: 6,
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
    fontWeight: "600",
    color: "#ffffff",
  },
  btnGhost: {
    backgroundColor: "transparent",
  },
  btnTextGhost: {
    fontSize: 17,
    fontWeight: "600",
  },
})

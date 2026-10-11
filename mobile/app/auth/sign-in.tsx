/** M2 Sign in. Google and GitHub buttons via Clerk useSSO. */
import { useSSO } from "@clerk/clerk-expo"
import { View, Text, TouchableOpacity, StyleSheet, Alert } from "react-native"

export default function SignInScreen() {
  const { startSSOFlow } = useSSO()

  const handleSSO = async (strategy: "google" | "github") => {
    try {
      await startSSOFlow({
        strategy: `oauth_${strategy}`,
        redirectUrl: "bountydesk://auth/callback",
      })
    } catch (err: any) {
      Alert.alert("Sign in failed", err.message)
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        <View style={styles.logoSquare} />
        <Text style={styles.title}>Sign in to BountyDesk</Text>
        <Text style={styles.subtitle}>Reviewers only. Your account decides which reports you see.</Text>
      </View>
      <View style={styles.btns}>
        <TouchableOpacity
          style={[styles.btn, styles.btnGitHub]}
          onPress={() => handleSSO("github")}
          activeOpacity={0.9}
        >
          <Text style={styles.btnTextDark}>Continue with GitHub</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, styles.btnGoogle]}
          onPress={() => handleSSO("google")}
          activeOpacity={0.9}
        >
          <Text style={styles.btnTextDark}>Continue with Google</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity onPress={() => {}} style={styles.quietLink}>
        <Text style={styles.quiet}>Not on the allowlist?</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 100,
    gap: 16,
  },
  hero: {
    flex: 1,
    gap: 14,
    alignItems: "flex-start",
  },
  logoSquare: {
    width: 72,
    height: 72,
    borderRadius: 18,
    backgroundColor: "#121213",
  },
  title: {
    fontSize: 32,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 17,
    lineHeight: 23,
    color: "#919199",
    maxWidth: 336,
  },
  btns: {
    gap: 12,
    marginTop: 24,
  },
  btn: {
    minHeight: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 22,
    width: "100%",
  },
  btnGitHub: {
    backgroundColor: "#ffffff",
  },
  btnGoogle: {
    backgroundColor: "rgba(255, 255, 255, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.20)",
  },
  btnTextDark: {
    fontSize: 17,
    fontWeight: "600",
    color: "#1a1a1f",
  },
  quietLink: {
    marginTop: 8,
  },
  quiet: {
    fontSize: 15,
    color: "#c9b6ff",
    textAlign: "center",
  },
})

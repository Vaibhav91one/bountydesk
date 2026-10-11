/** M3 Not authorized. Shown when GET /me returns allowlisted: false. */
import { View, Text, TouchableOpacity, StyleSheet } from "react-native"
import { useRouter } from "expo-router"
import { useAuth } from "@clerk/expo"

export default function NotAuthorizedScreen() {
  const router = useRouter()
  const { signOut } = useAuth()

  const handleRequestAccess = () => {
    // TODO: wire to the access-request API when it exists.
    alert("Access requested")
  }

  const handleSignOut = async () => {
    await signOut()
    router.replace("/auth/sign-in")
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>You are not on the reviewer allowlist</Text>
      <Text style={styles.body}>
        Your account signed in, but only allowlisted reviewers can open reports and sign
        verdicts. Ask an owner to add your email.
      </Text>
      <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={handleRequestAccess}>
        <Text style={styles.btnTextPrimary}>Request access</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={handleSignOut}>
        <Text style={styles.btnText}>Sign out</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    textAlign: "center",
    letterSpacing: -0.3,
  },
  body: {
    fontSize: 17,
    lineHeight: 23,
    color: "#919199",
    textAlign: "center",
    maxWidth: 300,
  },
  btn: {
    minHeight: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 22,
    marginTop: 8,
    width: "100%",
  },
  btnPrimary: {
    backgroundColor: "#7a4dff",
  },
  btnSecondary: {
    backgroundColor: "transparent",
  },
  btnTextPrimary: {
    fontSize: 17,
    fontWeight: "600",
    color: "#ffffff",
  },
  btnText: {
    fontSize: 17,
    fontWeight: "600",
    color: "#7a4dff",
  },
})

import { createContext, useContext } from "react"
import { Text, View, StyleSheet } from "react-native"

/**
 * The reviewer allowlist decision is made server-side on every request. The mobile app
 * asks /api/mobile/v1/me; if the token is valid but the email is not allowlisted, the
 * server returns allowlisted: false and the app routes to the not-authorized screen.
 */
export type MobileSession = {
  login: string
  email: string
  avatarUrl: string | null
  role: "owner" | "member" | "read_only"
  allowlisted: boolean
}

const SessionContext = createContext<MobileSession | null>(null)

export function SessionProvider({
  session,
  children,
}: {
  session: MobileSession | null
  children: React.ReactNode
}) {
  return (
    <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
  )
}

export function useSession() {
  return useContext(SessionContext)
}

export function NotAllowlistedScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>You are not on the reviewer allowlist</Text>
      <Text style={styles.body}>
        Your account signed in, but only allowlisted reviewers can open reports
        and sign verdicts. Ask an owner to add your email.
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    marginBottom: 16,
    textAlign: "center",
  },
  body: {
    fontSize: 17,
    lineHeight: 23,
    textAlign: "center",
    color: "#82828a",
  },
})

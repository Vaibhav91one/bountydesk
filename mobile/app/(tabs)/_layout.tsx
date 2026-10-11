/** M3 Tabs layout for the signed-in reviewer shell. */
import { useAuth } from "@clerk/expo"
import { Redirect, Tabs } from "expo-router"
import { useEffect, useState } from "react"
import { View, Text, StyleSheet } from "react-native"

import { api, ApiError } from "@/lib/api"
import { useHandleApiError } from "@/lib/use-api-error"
import type { MobileMe } from "@/lib/types"

/**
 * Signed-in shell. Redirects to /auth/splash when there is no session,
 * then checks /me to decide between the tabs and the not-authorized screen.
 */
export default function TabsLayout() {
  const { isLoaded, isSignedIn } = useAuth()
  const [allowlisted, setAllowlisted] = useState<boolean | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const handleApiError = useHandleApiError()

  useEffect(() => {
    if (!isSignedIn) return
    api<MobileMe>("/me")
      .then((me) => setAllowlisted(me.allowlisted))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 403) {
          // allowlisted:false or a read-only reviewer on /me -> not-authorized screen.
          setAllowlisted(false)
          return
        }
        // 401 signs the user out via the shared handler.
        if (e instanceof ApiError && e.status === 401) {
          handleApiError(e)
          return
        }
        // Anything else (network error, 5xx): surface it and stay put so the
        // user can retry instead of landing on the not-authorized screen.
        setCheckError(e instanceof Error ? e.message : String(e))
      })
  }, [isSignedIn, handleApiError])

  if (!isLoaded) {
    return null
  }

  if (!isSignedIn) {
    return <Redirect href="/auth/splash" />
  }

  if (allowlisted === false) {
    return <Redirect href="/auth/not-authorized" />
  }

  // A network or 5xx error from /me: show the error so the user can retry.
  if (checkError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{checkError}</Text>
      </View>
    )
  }

  // While the /me check is in flight with a valid session, pause rendering.
  if (isSignedIn && allowlisted === null) {
    return null
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: "#7a4dff",
        tabBarInactiveTintColor: "#919199",
        tabBarStyle: styles.tabBar,
        tabBarLabelStyle: styles.tabLabel,
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Home" }} />
      <Tabs.Screen name="queue" options={{ title: "Queue" }} />
      <Tabs.Screen name="reports" options={{ title: "Reports" }} />
      <Tabs.Screen
        name="review"
        options={{
          title: "",
          tabBarIcon: () => <View style={styles.fab}><Text style={styles.fabCount}>3</Text></View>,
        }}
      />
      <Tabs.Screen name="inbox" options={{ title: "Inbox" }} />
      <Tabs.Screen name="more" options={{ title: "More" }} />
    </Tabs>
  )
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontSize: 16, color: "#ff5b5b" },
  tabBar: {
    flexDirection: "row",
    height: 88,
    paddingBottom: 20,
    backgroundColor: "#222228",
    borderTopColor: "rgba(255, 255, 255, 0.10)",
  },
  tabLabel: {
    fontSize: 12,
    fontWeight: "500",
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#7a4dff",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 40,
  },
  fabCount: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "700",
  },
})

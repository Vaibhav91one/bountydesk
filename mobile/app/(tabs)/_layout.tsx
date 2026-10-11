/** M19 Settings (More tab). Links to Connections, Integrations, Target and scope, Privacy, Terms, Submit a report. Stub. */
import { useAuth } from "@clerk/clerk-expo"
import { Redirect, Tabs } from "expo-router"
import { useEffect, useState } from "react"
import { View, Text, StyleSheet } from "react-native"

import { api, ApiError } from "@/lib/api"
import type { MobileMe } from "@/lib/types"

/**
 * Signed-in shell. Redirects to /auth/splash when there is no session,
 * then checks /me to decide between the tabs and the not-authorized screen.
 */
export default function TabsLayout() {
  const { isLoaded, isSignedIn } = useAuth()
  const [allowlisted, setAllowlisted] = useState<boolean | null>(null)

  useEffect(() => {
    if (!isSignedIn) return
    api<MobileMe>("/me")
      .then((me) => setAllowlisted(me.allowlisted))
      .catch((_e: ApiError) => setAllowlisted(false))
  }, [isSignedIn])

  if (!isLoaded) {
    return null
  }

  if (!isSignedIn) {
    return <Redirect href="/auth/splash" />
  }

  if (allowlisted === false) {
    return <Redirect href="/auth/not-authorized" />
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

/** M4-M6 tabs layout. Signed-in reviewer shell with the Variant C floating tab dock.
 *
 * Matches docs/site/screens/m4.html navigation chrome:
 * - Glass top bar with bell (Inbox) and more menu on the right
 * - Floating tab pill at the bottom: Home, Queue, Reports, a separate Review FAB,
 *   the bell icon for Inbox, and a more menu.
 *
 * The tabs are rendered as a custom dock (not expo-router Tabs) to match the design.
 */
import { useAuth } from "@clerk/expo"
import { Redirect, Slot, useRouter, usePathname } from "expo-router"
import { useEffect, useState } from "react"
import { View, Text, StyleSheet, Pressable } from "react-native"
import { LinearGradient } from "expo-linear-gradient"
import { StatusBar } from "expo-status-bar"

import { api, ApiError } from "@/lib/api"
import { useHandleApiError } from "@/lib/use-api-error"
import type { HomeSummary } from "@/lib/types"
import { darkTheme } from "@/theme"
import { Icon } from "@/components/ui/IconButton"

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
    api<HomeSummary>("/home")
      .then(() => setAllowlisted(true))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 403) {
          setAllowlisted(false)
          return
        }
        if (e instanceof ApiError && e.status === 401) {
          handleApiError(e)
          return
        }
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

  if (checkError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{checkError}</Text>
      </View>
    )
  }

  if (isSignedIn && allowlisted === null) {
    return null
  }

  return <TabsShell />
}

function TabsShell() {
  const router = useRouter()
  const pathname = usePathname()

  // Map the current route to the active tab.
  const activeTab = pathname.startsWith("/(tabs)/reports") ? "reports"
    : pathname.startsWith("/(tabs)/queue") ? "queue"
    : "home"

  const tabs: { key: string; label: string; icon: string; route: string }[] = [
    { key: "home", label: "Home", icon: "home", route: "/(tabs)" },
    { key: "queue", label: "Queue", icon: "queue", route: "/(tabs)/queue" },
    { key: "reports", label: "Reports", icon: "reports", route: "/(tabs)/reports" },
  ]

  const handleTab = (route: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (router as any).replace(route)
  }

  return (
    <View style={styles.shellContainer}>
      <StatusBar style="light" />

      {/* Top bar: bell (Inbox) + more menu */}
      <View style={styles.topBar}>
        <Pressable
          onPress={() => router.push("/(tabs)/inbox")}
          style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, styles.topBtn]}
          aria-label="Inbox"
        >
          <Icon name="bell" size={22} stroke={darkTheme.colors.foreground} />
        </Pressable>
        <Pressable
          onPress={() => router.push("/(tabs)/more")}
          style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, styles.topBtn]}
          aria-label="More"
        >
          <Icon name="more" size={22} stroke={darkTheme.colors.foreground} />
        </Pressable>
      </View>

      {/* Page content */}
      <View style={styles.content}>
        <Slot />
      </View>

      {/* Bottom dock: floating tab pill + Review FAB */}
      <View style={styles.dock}>
        <LinearGradient
          colors={[darkTheme.colors.glass, darkTheme.colors.glass]}
          style={styles.tabsContainer}
        >
          {tabs.map((tab) => {
            const isActive = activeTab === tab.key
            return (
              <Pressable
                key={tab.key}
                onPress={() => handleTab(tab.route)}
                style={[
                  styles.tab,
                  isActive && { backgroundColor: darkTheme.colors.fill },
                ]}
              >
                <Icon
                  name={tab.icon as any}
                  size={24}
                  stroke={isActive ? darkTheme.colors.brand : darkTheme.colors.muted}
                />
                <Text
                  style={[
                    styles.tabLabel,
                    { color: isActive ? darkTheme.colors.foreground : darkTheme.colors.muted },
                  ]}
                >
                  {tab.label}
                </Text>
              </Pressable>
            )
          })}
        </LinearGradient>

        {/* Review FAB - matches .fab in c.css with data-review="3" */}
        <Pressable
          onPress={() => router.push("/(tabs)/review")}
          style={styles.fab}
        >
          <LinearGradient
            colors={[darkTheme.colors.brand, darkTheme.colors.brand]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.fabInner}
          >
            <Icon name="check" size={28} stroke="#ffffff" strokeWidth={2.2} />
            <View style={styles.fabBadge}>
              <Text style={styles.fabBadgeText}>3</Text>
            </View>
          </LinearGradient>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  shellContainer: {
    flex: 1,
    backgroundColor: darkTheme.colors.background,
  },
  topBar: {
    position: "absolute",
    top: 54,
    right: 16,
    zIndex: 30,
    flexDirection: "row",
    gap: 8,
  },
  topBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    flex: 1,
    marginTop: 54 + 48,
    marginBottom: 120,
  },
  dock: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 30,
    zIndex: 30,
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
  },
  tabsContainer: {
    flex: 1,
    height: 64,
    borderRadius: 32,
    padding: 6,
    gap: 2,
    flexDirection: "row",
  },
  tab: {
    flex: 1,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  tabLabel: {
    fontSize: 12,
    fontWeight: "500",
  },
  fab: {
    width: 64,
    height: 64,
    borderRadius: 32,
    flexShrink: 0,
  },
  fabInner: {
    width: "100%",
    height: "100%",
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  fabBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: 11,
    backgroundColor: darkTheme.colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  fabBadgeText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontSize: 16, color: darkTheme.colors.red },
})

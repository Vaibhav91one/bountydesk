/**
 * Signed-in reviewer shell using the installed Expo native tabs.
 *
 * Per docs/site/native-ui.html the tab bar holds only Home, Queue, Reports.
 * Review next (m11) and the bell/more chrome are NOT tabs — they are overlaid
 * on the three tab screens by <TopBarPill> and <ReviewFab> in components/.
 *
 * Auth gate: Clerk says "signed in", then GET /home checks the reviewer
 * allowlist. 403 -> not-authorized.
 */
import { useAuth } from "@clerk/expo"
import { Redirect } from "expo-router"
import { NativeTabs } from "expo-router/unstable-native-tabs"
import { useEffect, useState } from "react"
import { View, Text, StyleSheet } from "react-native"

import { api, ApiError } from "@/lib/api"
import { useHandleApiError } from "@/lib/use-api-error"
import type { HomeSummary } from "@/lib/types"
import { Icon } from "@/components/icons"
import { useTheme } from "@/theme"

export default function TabsLayout() {
  const { isLoaded, isSignedIn } = useAuth()
  const [allowlisted, setAllowlisted] = useState<boolean | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const handleApiError = useHandleApiError()

  // Remember the /me + /home allowlist result for the lifetime of the session
  // so a signed-in reviewer who failed the allowlist (403 -> not-authorized)
  // is not re-checked on every mount of the tab shell. Without this, AuthLayout
  // would redirect back here, /home 403s again, and the loop never resolves.
  // The state resets to null on sign-out (new mount of the layout), so a
  // different reviewer starts clean.
  useEffect(() => {
    if (!isSignedIn) return
    if (allowlisted !== null) return

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
  }, [isSignedIn, allowlisted, handleApiError])

  if (!isLoaded) return null
  if (!isSignedIn) return <Redirect href="/auth/splash" />
  if (allowlisted === false) return <Redirect href="/auth/not-authorized" />
  if (checkError) return <View style={styles.centered}><Text style={styles.error}>{checkError}</Text></View>
  if (allowlisted === null) return null

  return <TabsShell />
}

function TabsShell() {
  const { colors } = useTheme()
  return (
    <NativeTabs
      backgroundColor={colors.glass}
      iconColor={{ default: colors.muted, selected: colors.brand }}
      tintColor={colors.brand}
      labelStyle={{ fontSize: 12, fontWeight: "500" }}
      screenListeners={{
        focus: () => {},
      }}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon src={<Icon name="home" size={24} />} />
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="queue">
        <NativeTabs.Trigger.Icon src={<Icon name="queue" size={24} />} />
        <NativeTabs.Trigger.Label>Queue</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="reports">
        <NativeTabs.Trigger.Icon src={<Icon name="reports" size={24} />} />
        <NativeTabs.Trigger.Label>Reports</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontSize: 16, color: "#EF4444" },
})

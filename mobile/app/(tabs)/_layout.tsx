/**
 * Signed-in reviewer shell: JS tabs with the hand-drawn <TabDock>.
 *
 * Per docs/site/native-ui.html the tab bar holds only Home, Queue, Reports.
 * Review next (m11) and the bell/more chrome are NOT tabs — they are overlaid
 * on the three tab screens by <TopBarPill> and <ReviewFab> in components/.
 *
 * Auth gate: Clerk says "signed in", then GET /home checks the reviewer
 * allowlist. 403 -> not-authorized.
 */
import { useAuth } from "@/lib/auth-hooks"
import { Redirect } from "expo-router"
import { LoadingState } from "@/components/primitives"
import { Tabs } from "expo-router/js-tabs"
import { useEffect, useState } from "react"
import { View, Text, StyleSheet } from "react-native"

import { api, ApiError } from "@/lib/api"
import { useHandleApiError } from "@/lib/use-api-error"
import type { HomeSummary } from "@/lib/types"
import { TabDock } from "@/components/TabDock"
import { font } from "@/lib/fonts"

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

  if (!isLoaded) return <LoadingState label="Signing you in" />
  if (!isSignedIn) return <Redirect href="/auth/splash" />
  if (allowlisted === false) return <Redirect href="/auth/not-authorized" />
  if (checkError) return <View style={styles.centered}><Text style={styles.error}>{checkError}</Text></View>
  if (allowlisted === null) return <LoadingState label="Checking access" />

  return <TabsShell />
}

function TabsShell() {
  return (
    <Tabs tabBar={(p) => <TabDock {...p} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: "transparent" } }}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="queue" />
      <Tabs.Screen name="reports" />
    </Tabs>
  )
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontFamily: font.regular, fontSize: 16, color: "#EF4444" },
})

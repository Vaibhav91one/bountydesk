/**
 * Signed-in reviewer shell. Variant C floating tab dock.
 *
 * Auth gate: Clerk says "signed in", then GET /home checks the reviewer
 * allowlist. 403 -> not-authorized. The chrome (glass top bar with bell +
 * more, floating tab pill, 64pt Review FAB with badge) is shared chrome
 * rendered by NativeTabsShell in components/NativeTabs.tsx, matching
 * docs/site/screens/m4.html and c.js's TABS constant.
 */
import { useAuth } from "@clerk/expo"
import { Redirect } from "expo-router"
import { useEffect, useState } from "react"
import { View, Text, StyleSheet } from "react-native"

import { NativeTabsShell } from "@/components/NativeTabs"
import { api, ApiError } from "@/lib/api"
import { useHandleApiError } from "@/lib/use-api-error"
import type { HomeSummary } from "@/lib/types"

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

  return <NativeTabsShell reviewCount={3} />
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontSize: 16, color: "#EF4444" },
})

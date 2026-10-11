/**
 * Root layout. Wraps every route in the Clerk provider so the session is available
 * everywhere, bridges the Clerk token into the API client so api() can attach the bearer
 * header without each caller importing Clerk directly, and renders the expo-router Stack
 * that child groups slot into.
 *
 * Also loads Inter and Geist Mono fonts (defined in c.css as --font-sans and --font-mono)
 * before the app becomes interactive.
 */
import { ClerkProvider } from "@clerk/expo"
import { tokenCache } from "@clerk/expo/token-cache"
import { Stack } from "expo-router"
import * as WebBrowser from "expo-web-browser"
import { useEffect, useState } from "react"
import { View, ActivityIndicator } from "react-native"

import { ClerkTokenBridge } from "@/components/clerk-token-bridge"
import { QueryProvider } from "@/components/QueryProvider"
import { useFonts } from "@/hooks/useFonts"
import { darkTheme } from "@/theme"

/**
 * Resolve the auth session as soon as the root layout mounts, so the SSO
 * redirect callback (e.g. /sso-callback) is handled regardless of which screen
 * the app launches to first.
 */
WebBrowser.maybeCompleteAuthSession()

export default function RootLayout() {
  const fontsReady = useFonts()
  const [showLoading, setShowLoading] = useState(true)

  useEffect(() => {
    if (fontsReady) {
      setShowLoading(false)
    }
  }, [fontsReady])

  if (showLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: darkTheme.colors.background, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={darkTheme.colors.brand} />
      </View>
    )
  }

  return (
    <ClerkProvider
      tokenCache={tokenCache}
      publishableKey={process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!}
    >
      <ClerkTokenBridge>
        <QueryProvider>
          <Stack screenOptions={{ headerShown: false }} />
        </QueryProvider>
      </ClerkTokenBridge>
    </ClerkProvider>
  )
}

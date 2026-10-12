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
import { Stack, useRouter } from "expo-router"
import * as Notifications from "expo-notifications"
import * as WebBrowser from "expo-web-browser"
import { useEffect, useState } from "react"
import { View, ActivityIndicator } from "react-native"

import { ClerkTokenBridge } from "@/components/clerk-token-bridge"
import { ToastProvider } from "@/components/primitives"
import { useFonts } from "@/hooks/useFonts"
import { routeForNotification } from "@/lib/push"
import { darkTheme } from "@/theme"
import { restoreThemeMode } from "@/lib/theme-mode"

/**
 * Resolve the auth session as soon as the root layout mounts, so the SSO
 * redirect callback (e.g. /sso-callback) is handled regardless of which screen
 * the app launches to first.
 */
WebBrowser.maybeCompleteAuthSession()

export default function RootLayout() {
  const router = useRouter()
  const fontsReady = useFonts()
  const [showLoading, setShowLoading] = useState(true)

  // Route the user to the report behind a tapped notification on cold start and
  // while the app is foregrounded. Placed above the font/loading early return so
  // a notification opened while the app is still bootstrapping is not lost.
  useEffect(() => {
    // The Stack only mounts once fonts are ready; navigating before that throws.
    if (showLoading) return
    const handleResponse = (response: Notifications.NotificationResponse | null) => {
      if (!response) return
      const route = routeForNotification(response.notification.request.content.data)
      if (route) router.push(route)
    }
    const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse)
    Notifications.getLastNotificationResponseAsync().then(handleResponse)
    return () => {
      subscription.remove()
    }
  }, [router, showLoading])

  // Apply the reviewer's saved Light/Dark choice before the first screen renders.
  useEffect(() => {
    restoreThemeMode()
  }, [])

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
        <ToastProvider>
          <Stack screenOptions={{ headerShown: false }} />
        </ToastProvider>
      </ClerkTokenBridge>
    </ClerkProvider>
  )
}

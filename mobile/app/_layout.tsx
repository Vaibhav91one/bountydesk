/**
 * Root layout. Wraps every route in the Clerk provider so the session is available
 * everywhere, bridges the Clerk token into the API client so api() can attach the bearer
 * header without each caller importing Clerk directly, and renders the expo-router Stack
 * that child groups slot into.
 */
import { ClerkProvider } from "@clerk/expo"
import { tokenCache } from "@clerk/expo/token-cache"
import { Stack } from "expo-router"

import { ClerkTokenBridge } from "@/components/clerk-token-bridge"

export default function RootLayout() {
  return (
    <ClerkProvider
      tokenCache={tokenCache}
      publishableKey={process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!}
    >
      <ClerkTokenBridge>
        <Stack screenOptions={{ headerShown: false }} />
      </ClerkTokenBridge>
    </ClerkProvider>
  )
}

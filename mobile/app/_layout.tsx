/**
 * Root layout. Wraps every route in the Clerk provider so the session is available
 * everywhere, and bridges the Clerk token into the API client so api() can attach
 * the bearer header without each caller importing Clerk directly.
 */
import { ClerkProvider } from "@clerk/clerk-expo"
import { tokenCache } from "@/lib/clerk-token-cache"
import { ClerkTokenBridge } from "@/components/clerk-token-bridge"

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ClerkProvider
      tokenCache={tokenCache}
      publishableKey={process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY}
    >
      <ClerkTokenBridge>{children}</ClerkTokenBridge>
    </ClerkProvider>
  )
}

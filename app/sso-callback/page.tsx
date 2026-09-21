import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";

/**
 * Where the OAuth provider returns after the custom sign-in buttons hand off. Clerk completes the
 * sign-in (or the sign-up transfer for a first-time account) and then sends the browser on to
 * /home, where the reviewer allowlist decides what they see.
 */
export default function SsoCallbackPage() {
  return (
    <AuthenticateWithRedirectCallback
      signInFallbackRedirectUrl="/home"
      signUpFallbackRedirectUrl="/home"
    />
  );
}

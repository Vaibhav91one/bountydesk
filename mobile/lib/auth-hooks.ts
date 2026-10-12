/**
 * useAuth with a dev fixture bypass. In fixture mode the reviewer is signed in and allowlisted with
 * no Clerk round trip; everywhere else this is Clerk's own hook. The flag is constant for the life
 * of a bundle, so the branch never changes between renders.
 */
import { useAuth as useClerkAuth } from "@clerk/expo"

import { fixturesEnabled } from "./fixtures"

const fixtureAuth = {
  isLoaded: true,
  isSignedIn: true,
  userId: "fixture-user",
  getToken: async () => null,
  signOut: async () => {},
}

export function useAuth(): ReturnType<typeof useClerkAuth> {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return fixturesEnabled() ? (fixtureAuth as unknown as ReturnType<typeof useClerkAuth>) : useClerkAuth()
}

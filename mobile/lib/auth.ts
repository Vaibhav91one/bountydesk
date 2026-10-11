/**
 * Auth-flow redirect logic, extracted as a pure function so the layout guards
 * are unit-testable without rendering a router.
 *
 * The auth group holds splash, sign-in, and not-authorized. When a session
 * resolves we want to bounce a signed-in user toward the tab shell — but ONLY
 * from splash and sign-in. A signed-in reviewer who is on /auth/not-authorized
 * has just failed the server allowlist (403), so redirecting them to /(tabs)
 * would re-run /home, 403 again, and redirect back here forever. Keeping them
 * on not-authorized is the only way the screen is reachable at all.
 *
 * UseSegments returns the route segments, e.g. ["auth", "not-authorized"] or
 * ["(tabs)", "index"]. We only care about the first two segments within the
 * auth group.
 */
export type RedirectTarget = string | null

/**
 * Returns the href to redirect to (if any) given the current route segments
 * and signed-in state.
 *
 * - signed-in on splash or sign-in -> the tab shell ("/(tabs)")
 * - signed-in on not-authorized   -> null (stay; the allowlist failed)
 * - signed-out on a tabs route     -> "/auth/splash"
 * - everything else                -> null
 */
export function authRedirect(segments: readonly string[], isSignedIn: boolean): RedirectTarget {
  if (segments.length === 0) return null

  const inAuthGroup = segments[0] === "auth"
  const inTabsGroup = segments[0] === "(tabs)"

  if (inAuthGroup) {
    // Only bounce splash/sign-in. not-authorized must be left alone for a
    // signed-in reviewer, otherwise the 403 loop described above.
    if (isSignedIn && segments[1] !== "not-authorized") {
      return "/(tabs)"
    }
    return null
  }

  if (inTabsGroup) {
    if (!isSignedIn) return "/auth/splash"
    return null
  }

  return null
}

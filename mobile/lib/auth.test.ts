import { authRedirect } from "./auth"

describe("authRedirect", () => {
  it("leaves a signed-in reviewer on not-authorized (no loop)", () => {
    expect(authRedirect(["auth", "not-authorized"], true)).toBeNull()
  })

  it("redirects a signed-in user from sign-in to the tab shell", () => {
    expect(authRedirect(["auth", "sign-in"], true)).toBe("/(tabs)")
  })

  it("redirects a signed-in user from splash to the tab shell", () => {
    expect(authRedirect(["auth", "splash"], true)).toBe("/(tabs)")
  })

  it("leaves a signed-out user on sign-in", () => {
    expect(authRedirect(["auth", "sign-in"], false)).toBeNull()
  })

  it("redirects a signed-out user on tabs to /auth/splash", () => {
    expect(authRedirect(["(tabs)", "index"], false)).toBe("/auth/splash")
  })

  it("does not redirect a signed-in user on tabs", () => {
    expect(authRedirect(["(tabs)", "index"], true)).toBeNull()
  })

  it("ignores unrelated routes", () => {
    expect(authRedirect(["settings"], true)).toBeNull()
    expect(authRedirect([], false)).toBeNull()
  })

  it("still redirects a signed-in user on a 3rd-segment auth child", () => {
    // e.g. /auth/sign-in/recovery -> still a sign-in flow, bounce to tabs
    expect(authRedirect(["auth", "sign-in", "recovery"], true)).toBe("/(tabs)")
  })
})

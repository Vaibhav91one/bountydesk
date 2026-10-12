/** The entry route shows the splash while the session resolves, then routes by sign-in state. */
import React from "react"
import { render } from "@testing-library/react-native"

let mockAuth = { isLoaded: false, isSignedIn: false }

jest.mock("@/lib/auth-hooks", () => ({ useAuth: () => mockAuth }))
jest.mock("expo-router", () => ({
  Redirect: ({ href }: { href: string }) => {
    const { Text } = require("react-native")
    return require("react").createElement(Text, null, `redirect:${href}`)
  },
}))
jest.mock("@/components/SvgImage", () => ({ SvgImage: () => null }))

const IndexScreen = require("../app/index").default

describe("entry route", () => {
  it("renders the splash tagline while the session is loading", async () => {
    mockAuth = { isLoaded: false, isSignedIn: false }
    const { getByText } = await render(<IndexScreen />)
    expect(getByText("Triage you can trust, one approval at a time.")).toBeTruthy()
  })

  it("redirects a signed-in user to the tabs once loaded", async () => {
    mockAuth = { isLoaded: true, isSignedIn: true }
    const { getByText } = await render(<IndexScreen />)
    expect(getByText("redirect:/(tabs)")).toBeTruthy()
  })
})

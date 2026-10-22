/**
 * Screen-reader and touch-target checks for the chrome on every tab screen: the Review button and
 * the bell / more buttons. The labels were already there; the role and the 48dp Android minimum
 * were not, so a screen reader announced a bare label and a thumb could miss the 46dp buttons.
 */
import { render, fireEvent, screen } from "@testing-library/react-native"
import { StyleSheet } from "react-native"
import { TopBarPill } from "../components/TopBarPill"
import { ReviewFab } from "../components/ReviewFab"

jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn() }) }))
jest.mock("@/lib/use-query", () => ({
  useApiQuery: () => ({ data: { needsYou: 3, columns: [] } }),
}))
jest.mock("@/theme", () => {
  const colors = new Proxy({}, { get: () => "#111111" })
  return {
    useTheme: () => ({
      colors,
      spacing: { touchTarget: 44, itemMinHeight: 56, buttonMinHeight: 52, screenPadding: 20, topBarHeight: 54 },
      round: { buttonRadius: 26, cardRadius: 24, fieldRadius: 20 },
      typography: {},
    }),
  }
})
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }))

const ANDROID_MIN_DP = 48

describe("tab screen chrome", () => {
  it("announces the bell and more buttons as buttons, not bare labels", async () => {
    await render(<TopBarPill />)
    expect(screen.getByRole("button", { name: "Inbox" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "More" })).toBeTruthy()
  })

  it("keeps the bell and more buttons at least 48dp tall", async () => {
    await render(<TopBarPill />)
    const style = StyleSheet.flatten(screen.getByRole("button", { name: "Inbox" }).props.style)
    expect(style.height).toBeGreaterThanOrEqual(ANDROID_MIN_DP)
    expect(style.width).toBeGreaterThanOrEqual(ANDROID_MIN_DP)
  })

  it("announces the Review button as a button with the waiting count", async () => {
    await render(<ReviewFab count={3} />)
    expect(screen.getByRole("button", { name: "Review next verdict, 3 waiting" })).toBeTruthy()
  })

  it("announces each More menu entry as a button", async () => {
    await render(<TopBarPill />)
    await fireEvent.press(screen.getByRole("button", { name: "More" }))
    expect(screen.getAllByRole("button").length).toBeGreaterThan(2)
  })
})

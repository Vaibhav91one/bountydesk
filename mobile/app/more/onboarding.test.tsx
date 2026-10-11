/**
 * Render tests for M27 Onboarding (app/more/onboarding.tsx).
 *
 * The screen has no API query (it is a static diagram), so the test verifies
 * the seven stage nodes render with their labels and titles, plus the notes
 * section with repo name, commit, and status.
 */
import React from "react"
import { render, waitFor } from "@testing-library/react-native"

jest.mock("@/theme", () => ({
  useTheme: () => ({
    colors: {
      background: "#0f0f0f",
      card: "#131314",
      foreground: "#ffffff",
      muted: "#b8b8b8",
      faint: "#8c8c8c",
      line: "rgba(255,255,255,0.08)",
      glass: "rgba(15,15,17,0.6)",
      "glass-edge": "rgba(255,255,255,0.10)",
      fill: "rgba(255,255,255,0.10)",
      brand: "#9475E6",
      "brand-soft": "#C9B0FF",
      red: "#B93645",
    },
    phase: {
      triaging: "#B49AFFFF",
      reproducing: "#9DB6FF",
      analysis: "#E0B0FF",
      approval: "#F1D06B",
      delivered: "#7CD8A0",
      closed: "#888888",
    },
    spacing: { itemMinHeight: 56 },
    round: { cardRadius: 24, buttonRadius: 26 },
    typography: { fontMono: "GeistMono" },
  }),
}))

let OnboardingScreen: React.ComponentType

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  OnboardingScreen = require("./onboarding").default
})

describe("M27 Onboarding", () => {
  it("renders all seven stage nodes with labels and titles", async () => {
    const { getByText, getAllByText } = await render(<OnboardingScreen />)

    await waitFor(() => {
      expect(getAllByText("Onboarding").length).toBeGreaterThan(0)
    })

    // Meta line
    expect(getByText("How a repository becomes a bound target")).toBeTruthy()

    // All seven stages
    expect(getByText("Stage 1")).toBeTruthy()
    expect(getByText("Connected repo")).toBeTruthy()
    expect(getByText("Stage 2")).toBeTruthy()
    expect(getByText("Classify and review")).toBeTruthy()
    expect(getByText("Stage 3")).toBeTruthy()
    expect(getByText("Build in sandbox")).toBeTruthy()
    expect(getByText("Stage 4")).toBeTruthy()
    expect(getByText("Snapshot and manifest")).toBeTruthy()
    expect(getByText("Stage 5")).toBeTruthy()
    expect(getByText("Human approves")).toBeTruthy()
    expect(getByText("Stage 6")).toBeTruthy()
    expect(getByText("Verify offline")).toBeTruthy()
    expect(getByText("Stage 7")).toBeTruthy()
    expect(getByText("Configured target")).toBeTruthy()

    // Notes section
    expect(getByText("Notes")).toBeTruthy()
    expect(getByText("juice-shop")).toBeTruthy()
    expect(getByText("1867b92")).toBeTruthy()
    expect(getByText("Configured")).toBeTruthy()
  })
})

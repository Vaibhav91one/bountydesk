/**
 * Render tests for M22 Target and scope (app/more/target-and-scope.tsx).
 *
 * Covers loading, data, and error states. Verifies the screen renders the
 * pinned image digest, snapshot id, build marker, scope rules, and readiness
 * check row with a Ready pill.
 */
import React from "react"
import { render, waitFor } from "@testing-library/react-native"

const mockUseApiQuery = jest.fn()

jest.mock("@/lib/use-query", () => ({
  useApiQuery: (...args: unknown[]) => mockUseApiQuery(...args),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message?: string) {
      super(message)
      this.status = status
      this.name = "ApiError"
    }
  },
}))

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

const mockCaseFile = {
  id: "BD-1042",
  targetScope: {
    imageDigest: "sha256:9f2c4e0a7b1d6c83e5a24f90b7d1c3e86a5f0b2d94c71e8a3b6d05f2c8e1a947",
    snapshotId: "snap-7c41e9d2",
    buildMarker: "bd-build-1867b92-ok",
    scopeRules: { allow: ["localhost"], egress: "None" },
    readinessPath: "/",
    startCommand: "npm start",
  },
}

let TargetAndScopeScreen: React.ComponentType

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  TargetAndScopeScreen = require("./target-and-scope").default
})

describe("M22 Target and scope", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders loading state without crashing", async () => {
    mockUseApiQuery.mockReturnValue({ data: undefined, error: null })
    const { toJSON } = await render(<TargetAndScopeScreen />)
    expect(toJSON()).not.toBeNull()
  })

  it("renders pinned image, scope rules, and readiness from the case file", async () => {
    mockUseApiQuery.mockReturnValue({ data: mockCaseFile, error: null })
    const { getByText, getAllByText } = await render(<TargetAndScopeScreen />)

    await waitFor(() => {
      expect(getAllByText("Target and scope").length).toBeGreaterThan(0)
    })
    // Meta
    expect(getByText("juice-shop · v17.3.0 · 1867b92")).toBeTruthy()
    // Pinned image section
    expect(getByText("Image digest")).toBeTruthy()
    expect(getByText(/sha256:9f2c4e0a7b/)).toBeTruthy()
    expect(getByText("Snapshot id")).toBeTruthy()
    expect(getByText("snap-7c41e9d2")).toBeTruthy()
    expect(getByText("Build")).toBeTruthy()
    expect(getByText("bd-build-1867b92-ok")).toBeTruthy()
    // Scope rules
    expect(getByText("Allow")).toBeTruthy()
    expect(getByText("localhost")).toBeTruthy()
    expect(getByText("Egress")).toBeTruthy()
    expect(getByText("None")).toBeTruthy()
    // Readiness
    expect(getByText("Health check")).toBeTruthy()
    expect(getByText(/port 3000/)).toBeTruthy()
    expect(getByText("Ready")).toBeTruthy()
  })

  it("renders mockup fallback values when targetScope is null", async () => {
    mockUseApiQuery.mockReturnValue({ data: { id: "BD-1042", targetScope: null }, error: null })
    const { getByText, getAllByText } = await render(<TargetAndScopeScreen />)

    await waitFor(() => {
      expect(getAllByText("Target and scope").length).toBeGreaterThan(0)
    })
    expect(getByText("Image digest")).toBeTruthy()
    expect(getByText(/sha256:9f2c4e0a7b/)).toBeTruthy()
    expect(getByText("snap-7c41e9d2")).toBeTruthy()
    expect(getByText("bd-build-1867b92-ok")).toBeTruthy()
  })

  it("renders an error message inline on non-auth errors", async () => {
    const err = new Error("Network failed")
    mockUseApiQuery.mockReturnValue({ data: undefined, error: err })
    const { getByText } = await render(<TargetAndScopeScreen />)
    expect(getByText("Network failed")).toBeTruthy()
  })
})

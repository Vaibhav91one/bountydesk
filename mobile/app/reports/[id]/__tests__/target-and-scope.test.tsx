/**
 * Render tests for M22 Target and scope (app/reports/[id]/target-and-scope.tsx).
 *
 * Covers loading, data, and error states. Verifies the screen reads its report
 * id from the route param, fetches /reports/<id>, renders scope rules as KvRows,
 * and shows an empty state when targetScope is null.
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

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn() }),
  useLocalSearchParams: () => ({ id: "BD-1042" }),
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
  targetVersion: "v17.3.0",
  target: { id: "t1", name: "owner/juice-shop", imageDigest: "sha256:abc123def456" },
  targetScope: {
    imageDigest: "sha256:abc123def456",
    snapshotId: null,
    buildMarker: "bd-build-1867b92-ok",
    scopeRules: [{ allow: "localhost" }],
    readinessPath: "/",
    startCommand: null,
    egress: "none",
  },
}

let TargetAndScopeScreen: React.ComponentType

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  TargetAndScopeScreen = require("../target-and-scope").default
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

  it("fetches /reports/<id> using the route param", async () => {
    mockUseApiQuery.mockReturnValue({ data: mockCaseFile, error: null })
    await render(<TargetAndScopeScreen />)
    await waitFor(() => {
      expect(mockUseApiQuery).toHaveBeenCalledWith("/reports/BD-1042")
    })
  })

  it("renders the allow rule 'localhost' from [{allow:'localhost'}] and None egress", async () => {
    mockUseApiQuery.mockReturnValue({ data: mockCaseFile, error: null })
    const { getByText, getAllByText } = await render(<TargetAndScopeScreen />)

    await waitFor(() => {
      expect(getAllByText("Target and scope").length).toBeGreaterThan(0)
    })
    expect(getByText("Allow")).toBeTruthy()
    expect(getByText("localhost")).toBeTruthy()
    expect(getByText("Egress")).toBeTruthy()
    expect(getByText("None")).toBeTruthy()
    // Meta from the case file target
    expect(getByText("juice-shop · v17.3.0 · 1867b92")).toBeTruthy()
  })

  it("shows 'No bound target' when targetScope is null", async () => {
    mockUseApiQuery.mockReturnValue({
      data: { id: "BD-1042", target: null, targetScope: null },
      error: null,
    })
    const { getByText } = await render(<TargetAndScopeScreen />)
    await waitFor(() => {
      expect(getByText("No bound target")).toBeTruthy()
    })
    expect(
      getByText("This report has no authorised target, so nothing was reproduced."),
    ).toBeTruthy()
  })

  it("renders an error message inline on non-auth errors", async () => {
    const err = new Error("Network failed")
    mockUseApiQuery.mockReturnValue({ data: undefined, error: err })
    const { getByText } = await render(<TargetAndScopeScreen />)
    expect(getByText("Network failed")).toBeTruthy()
  })
})

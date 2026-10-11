/**
 * Render tests for M15 Connection detail (app/more/connections/[id].tsx).
 *
 * Covers loading, data, not-found, and error states. Verifies the screen reads
 * its id from the route param, fetches /connections, finds the matching row,
 * and shows "Connection not found" when no row matches.
 */
import React from "react"
import { render, waitFor } from "@testing-library/react-native"

const mockUseApiQuery = jest.fn()
const mockLocalSearchParams = jest.fn<{ id: string }, []>()

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
  useLocalSearchParams: (...args: unknown[]) => mockLocalSearchParams(...args as []),
}))

jest.mock("@/theme", () => ({
  useTheme: () => ({
    colors: {
      background: "#0f0f0b",
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

const mockData = [
  {
    id: "repo-1",
    account: "Vaibhav91one",
    status: "admissible",
    fullName: "Vaibhav91one/juice-shop",
    owner: "Vaibhav91one",
    name: "juice-shop",
    label: "Connected",
    hint: "Reports opened here are accepted.",
    target: "v17.3.0",
    repoId: 12345,
    configured: true,
    connected: true,
    isPrivate: false,
    reportCount: 5,
    awaitingReview: 3,
    delivered: 2,
    lastReportAt: "2025-01-15T10:00:00.000Z",
    lastSyncedAt: "2025-01-15T09:00:00.000Z",
    manageUrl: "https://github.com/settings/installations/123",
    onboarding: null,
    onboardingProgress: null,
    onboardingDetail: null,
  },
]

let ConnectionDetailScreen: React.ComponentType

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ConnectionDetailScreen = require("../[id]").default
})

describe("M15 Connection detail", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLocalSearchParams.mockReturnValue({ id: "12345" })
  })

  it("renders loading state without crashing", async () => {
    mockUseApiQuery.mockReturnValue({ data: undefined, error: null })
    const { toJSON } = await render(<ConnectionDetailScreen />)
    expect(toJSON()).not.toBeNull()
  })

  it("renders repo name, visibility, clone, permissions and bound target from the row", async () => {
    mockUseApiQuery.mockReturnValue({ data: mockData, error: null })
    const { getByText, getAllByText } = await render(<ConnectionDetailScreen />)

    await waitFor(() => {
      expect(getAllByText("juice-shop").length).toBeGreaterThan(0)
    })
    // Meta line
    expect(getByText("Vaibhav91one/juice-shop")).toBeTruthy()
    // Repository section
    expect(getByText("Visibility")).toBeTruthy()
    expect(getByText("Public")).toBeTruthy()
    expect(getByText("Clone")).toBeTruthy()
    expect(getByText("Anonymous")).toBeTruthy()
    // Permissions
    expect(getByText("Metadata")).toBeTruthy()
    expect(getByText("Read")).toBeTruthy()
    expect(getByText("Issues")).toBeTruthy()
    expect(getAllByText("Read and write").length).toBeGreaterThan(0)
    expect(getByText("Security advisories")).toBeTruthy()
    expect(getByText("Contents")).toBeTruthy()
    expect(getByText("Not granted")).toBeTruthy()
    // Bound target shown inline as a plain KvRow
    expect(getByText("Target")).toBeTruthy()
    expect(getByText("v17.3.0")).toBeTruthy()
  })

  it("renders Private visibility and installation-token clone for a private repo", async () => {
    mockUseApiQuery.mockReturnValue({
      data: [{ ...mockData[0], isPrivate: true }],
      error: null,
    })
    const { getByText } = await render(<ConnectionDetailScreen />)
    await waitFor(() => {
      expect(getByText("Visibility")).toBeTruthy()
    })
    expect(getByText("Private")).toBeTruthy()
    expect(getByText("Installation token (Contents read)")).toBeTruthy()
  })

  it("shows 'Not set' target when configured is false", async () => {
    mockUseApiQuery.mockReturnValue({
      data: [{ ...mockData[0], configured: false, target: null }],
      error: null,
    })
    const { getByText } = await render(<ConnectionDetailScreen />)
    await waitFor(() => {
      expect(getByText("Bound target")).toBeTruthy()
    })
    expect(getByText("Not set")).toBeTruthy()
  })

  it("shows 'Connection not found' for an unknown id", async () => {
    mockLocalSearchParams.mockReturnValue({ id: "99999" })
    mockUseApiQuery.mockReturnValue({ data: mockData, error: null })
    const { getByText } = await render(<ConnectionDetailScreen />)
    await waitFor(() => {
      expect(getByText("Connection not found")).toBeTruthy()
    })
  })

  it("renders an error message inline on non-auth errors", async () => {
    const err = new Error("Network failed")
    mockUseApiQuery.mockReturnValue({ data: undefined, error: err })
    const { getByText } = await render(<ConnectionDetailScreen />)
    expect(getByText("Network failed")).toBeTruthy()
  })
})

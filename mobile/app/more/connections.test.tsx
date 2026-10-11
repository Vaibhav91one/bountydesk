/**
 * Render tests for M14 Connections (app/more/connections.tsx).
 *
 * Covers the three states useApiQuery can be in: loading, data, and error.
 * Verifies the screen renders the title, installation header, repo rows with
 * status pills, and the target links to onboarding and submit-a-target.
 */
import React from "react"
import { render, waitFor } from "@testing-library/react-native"

const mockUseApiQuery = jest.fn()
const mockPush = jest.fn()

jest.mock("@/lib/use-query", () => ({
  useApiQuery: (...args: unknown[]) => mockUseApiQuery(...args),
  useApiMutation: jest.fn(),
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
  useRouter: () => ({ push: mockPush }),
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
  {
    id: "repo-2",
    account: "Vaibhav91one",
    status: "not-configured",
    fullName: "Vaibhav91one/api-gateway",
    owner: "Vaibhav91one",
    name: "api-gateway",
    label: "Not configured",
    hint: "No target bound.",
    target: null,
    repoId: 12346,
    configured: false,
    connected: true,
    reportCount: 0,
    awaitingReview: 0,
    delivered: 0,
    lastReportAt: null,
    lastSyncedAt: "2025-01-15T09:00:00.000Z",
    manageUrl: "https://github.com/settings/installations/123",
    onboarding: null,
    onboardingProgress: null,
    onboardingDetail: null,
  },
  {
    id: "repo-3",
    account: "Vaibhav91one",
    status: "suspended",
    fullName: "Vaibhav91one/billing-core",
    owner: "Vaibhav91one",
    name: "billing-core",
    label: "Suspended",
    hint: "Suspended installation.",
    target: null,
    repoId: 12347,
    configured: false,
    connected: false,
    reportCount: 0,
    awaitingReview: 0,
    delivered: 0,
    lastReportAt: null,
    lastSyncedAt: "2025-01-15T09:00:00.000Z",
    manageUrl: "https://github.com/settings/installations/123",
    onboarding: null,
    onboardingProgress: null,
    onboardingDetail: null,
  },
]

let ConnectionsScreen: React.ComponentType

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ConnectionsScreen = require("./connections").default
})

describe("M14 Connections", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPush.mockClear()
  })

  it("renders loading state without crashing", async () => {
    mockUseApiQuery.mockReturnValue({ data: undefined, error: null })
    const { toJSON } = await render(<ConnectionsScreen />)
    expect(toJSON()).not.toBeNull()
  })

  it("renders the installation header and three repository rows with status pills", async () => {
    mockUseApiQuery.mockReturnValue({ data: mockData, error: null })
    const { getByText, getAllByText } = await render(<ConnectionsScreen />)

    await waitFor(() => {
      expect(getAllByText("Connections").length).toBeGreaterThan(0)
    })
    expect(getByText("Vaibhav91one")).toBeTruthy()
    expect(getByText("juice-shop")).toBeTruthy()
    expect(getByText("api-gateway")).toBeTruthy()
    expect(getByText("billing-core")).toBeTruthy()
    expect(getByText("Target bound")).toBeTruthy()
    expect(getByText("No target")).toBeTruthy()
    expect(getByText("Policy refused")).toBeTruthy()
    expect(getByText("View onboarding")).toBeTruthy()
    expect(getByText("Upload a target")).toBeTruthy()
  })

  it("renders an error message inline on non-auth errors", async () => {
    const err = new Error("Network failed")
    mockUseApiQuery.mockReturnValue({ data: undefined, error: err })
    const { getByText } = await render(<ConnectionsScreen />)
    expect(getByText("Network failed")).toBeTruthy()
  })
})

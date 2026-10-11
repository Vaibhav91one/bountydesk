/**
 * Render tests for M6 Reports.
 * Covers loading, data, search filtering, and no-results states.
 */
import { render, fireEvent, waitFor } from "@testing-library/react-native"
import ReportsScreen from "../app/(tabs)/reports"

const mockPush = jest.fn()
const mockBack = jest.fn()

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
}))

jest.mock("@/lib/use-query", () => ({
  useApiQuery: jest.fn(),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, _code?: string, message?: string) {
      super(message ?? `API error: ${status}`)
      this.status = status
      this.name = "ApiError"
    }
  },
}))

jest.mock("@/theme", () => ({
  useTheme: () => ({
    colors: {
      page: "#121317",
      background: "#121317",
      card: "#1e1f24",
      raised: "#2a2b33",
      foreground: "#f5f5f7",
      muted: "#aaa",
      faint: "#777",
      line: "#2a2b33",
      glass: "#121317",
      "glass-edge": "#333",
      fill: "#2a2b33",
      selection: "#333",
      sheet: "#1e1f24",
      "sheet-card": "#1e1f24",
      hover: "#2a2b33",
      brand: "#7c3aed",
      "brand-soft": "#d8d7e5",
      red: "#ef4444",
    },
    spacing: { screenPadding: 20, sectionGap: 28, itemPadding: 18, itemMinHeight: 56, buttonMinHeight: 52, touchTarget: 44, cornerRadius: 24, fieldRadius: 20, tabBarHeight: 88, topBarHeight: 54 },
    round: { screenRadius: 55, cardRadius: 24, buttonRadius: 26, fieldRadius: 20, tabPillRadius: 32 },
    typography: { fontFamily: "Inter", fontMono: "GeistMono", bodyFontSize: 17, bodyLineHeight: 23, h1FontSize: 28, h1LineHeight: 32, sectionHeaderFontSize: 20, sectionHeaderLineHeight: 24, noteFontSize: 13, pillFontSize: 13, h2FontSize: 24 },
  }),
}))

jest.mock("@/lib/phases", () => ({
  usePhaseColor: (key: string) => {
    const map: Record<string, string> = {
      triaging: "#93c5fd",
      reproducing: "#60a5fa",
      analysis: "#ec4899",
      approval: "#eab308",
      delivered: "#4ade80",
      closed: "#6b7280",
    }
    return map[key] ?? "#6b7280"
  },
  phaseLabel: (key: string) => key,
  phaseTint: (color: string) => color + "29",
}))

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({ signOut: jest.fn(), isLoaded: true, isSignedIn: true }),
}))

jest.mock("@/components/TopBarPill", () => ({
  TopBarPill: () => null,
}))

jest.mock("@/components/ReviewFab", () => ({
  ReviewFab: () => null,
}))

jest.mock("@/components/icons", () => ({
  Icon: ({ name }: { name: string }) => {
    const { Text } = require("react-native")
    const { createElement } = require("react")
    return createElement(Text, { children: `icon-${name}` })
  },
}))

jest.mock("@/components/SvgImage", () => ({
  SvgImage: ({ name }: { name: string }) => {
    const { View } = require("react-native")
    const { createElement } = require("react")
    return createElement(View, { testID: `svg-${name}` })
  },
}))

const mockUseApiQuery = require("@/lib/use-query").useApiQuery as jest.Mock

// Mock data matching m6.html
const mockReportsData = {
  reports: [
    { id: "BD-1042", title: "Stored XSS in search results", sourceLabel: "#482", targetName: "juice-shop", channel: "github", state: "AWAITING_APPROVAL", outcome: "REPRODUCED", verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 5, updatedAt: "2025-01-01T10:00:00Z", awaitingVerdictId: "v1", investigating: false, origin: "juice-shop" },
    { id: "BD-1044", title: "Missing rate limit on login", sourceLabel: "#484", targetName: "juice-shop", channel: "github", state: "AWAITING_APPROVAL", outcome: "REPRODUCED", verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 3, updatedAt: "2025-01-01T09:46:00Z", awaitingVerdictId: "v2", investigating: false, origin: "juice-shop" },
    { id: "BD-1047", title: "Open redirect on /login", sourceLabel: null, targetName: null, channel: "email", state: "TRIAGING", outcome: null, verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 0, updatedAt: "2025-01-01T10:06:00Z", awaitingVerdictId: null, investigating: false, origin: "email" },
    { id: "BD-1045", title: "SQL injection in search", sourceLabel: "#485", targetName: "juice-shop", channel: "github", state: "REPRODUCING", outcome: null, verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: "RUNNING", deliveryState: null, handoffFailed: false, eventCount: 4, updatedAt: "2025-01-01T10:00:00Z", awaitingVerdictId: null, investigating: true, origin: "juice-shop" },
    { id: "BD-1033", title: "Reflected XSS in /search", sourceLabel: "#473", targetName: "juice-shop", channel: "github", state: "DELIVERED", outcome: "REPRODUCED", verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: "DELIVERED", handoffFailed: false, eventCount: 8, updatedAt: "2025-01-01T08:00:00Z", awaitingVerdictId: null, investigating: false, origin: "juice-shop" },
    { id: "BD-1030", title: "CSRF on profile update", sourceLabel: "#470", targetName: "juice-shop", channel: "github", state: "DENIED", outcome: "NOT_REPRODUCED", verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 2, updatedAt: "2025-01-01T06:00:00Z", awaitingVerdictId: null, investigating: false, origin: "juice-shop" },
  ],
  total: 6,
  nextOffset: null,
}

describe("M6 Reports", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders the reports title and count", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockReportsData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<ReportsScreen />)

    expect(getByText("Reports")).toBeTruthy()
    expect(getByText("6 reports")).toBeTruthy()
  })

  it("renders all phase filter chips", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockReportsData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByTestId, getAllByText } = await render(<ReportsScreen />)

    expect(getAllByText("All").length).toBeGreaterThan(0)
    expect(getAllByText("Approval").length).toBeGreaterThan(0)
    expect(getAllByText("Reproducing").length).toBeGreaterThan(0)
    expect(getAllByText("Analysis").length).toBeGreaterThan(0)
    expect(getAllByText("Triaging").length).toBeGreaterThan(0)
    expect(getAllByText("Delivered").length).toBeGreaterThan(0)
    expect(getAllByText("Closed").length).toBeGreaterThan(0)
    expect(getByTestId("chip-approval")).toBeTruthy()
    expect(getByTestId("chip-delivered")).toBeTruthy()
    expect(getByTestId("chip-closed")).toBeTruthy()
  })

  it("renders report titles and subtitles", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockReportsData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<ReportsScreen />)

    expect(getByText("Stored XSS in search results")).toBeTruthy()
    expect(getByText("BD-1042 · juice-shop")).toBeTruthy()
  })

  it("filters by search term", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockReportsData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByPlaceholderText, getByText, queryByText } = await render(<ReportsScreen />)

    const searchInput = getByPlaceholderText("Search reports")
    fireEvent.changeText(searchInput, "XSS")

    await waitFor(() => {
      expect(getByText("Stored XSS in search results")).toBeTruthy()
    })
    expect(queryByText("Missing rate limit on login")).toBeNull()
  })

  it("filters by phase chip", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockReportsData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByTestId, getByText, queryByText } = await render(<ReportsScreen />)

    fireEvent.press(getByTestId("chip-triaging"))

    await waitFor(() => {
      expect(getByText("Open redirect on /login")).toBeTruthy()
    })
    expect(queryByText("Stored XSS in search results")).toBeNull()
  })

  it("shows no-results state when no reports match", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockReportsData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByPlaceholderText, getByText } = await render(<ReportsScreen />)

    const searchInput = getByPlaceholderText("Search reports")
    fireEvent.changeText(searchInput, "nonexistent report")

    await waitFor(() => {
      expect(getByText(/No reports match/)).toBeTruthy()
    })
    expect(getByText("Clear search")).toBeTruthy()
  })

  it("clears search and filter from the no-results state", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockReportsData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByPlaceholderText, getByText } = await render(<ReportsScreen />)

    const searchInput = getByPlaceholderText("Search reports")
    fireEvent.changeText(searchInput, "nonexistent")

    await waitFor(() => {
      expect(getByText("Clear search")).toBeTruthy()
    })
    fireEvent.press(getByText("Clear search"))

    await waitFor(() => {
      expect(getByText("Stored XSS in search results")).toBeTruthy()
    })
  })

  it("renders loading state while fetching", async () => {
    mockUseApiQuery.mockReturnValue({
      data: undefined,
      error: undefined,
      isError: false,
      isFetching: true,
    })

    const { toJSON } = await render(<ReportsScreen />)
    const json = JSON.stringify(toJSON())
    expect(json).toContain("ActivityIndicator")
  })

  it("renders error message on non-auth error", async () => {
    const { ApiError } = require("@/lib/use-query")
    mockUseApiQuery.mockReturnValue({
      data: undefined,
      error: new ApiError(500, "err-server", "upstream timeout"),
      isError: true,
      isFetching: false,
    })

    const { getByText } = await render(<ReportsScreen />)
    expect(getByText(/upstream timeout/i)).toBeTruthy()
  })

  it("renders the footnote", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockReportsData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<ReportsScreen />)
    expect(getByText(/Every report keeps its full history/i)).toBeTruthy()
  })

  it("shows Running for investigating reports", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockReportsData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<ReportsScreen />)
    expect(getByText("Running")).toBeTruthy()
  })
})

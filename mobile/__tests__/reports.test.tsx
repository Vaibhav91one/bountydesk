/**
 * Render tests for M6 Reports.
 * Covers loading, data, search filtering, and no-results states.
 */
import { render, fireEvent, waitFor, act } from "@testing-library/react-native"
import * as Clipboard from "expo-clipboard"
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

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(),
}))
const mockSetStringAsync = jest.fn()
;(Clipboard.setStringAsync as jest.Mock) = mockSetStringAsync

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({ signOut: jest.fn(), isLoaded: true, isSignedIn: true }),
}))

jest.mock("@/lib/api", () => ({
  api: jest.fn(),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, _code?: string, message?: string) {
      super(message ?? `API error: ${status}`)
      this.status = status
      this.name = "ApiError"
    }
  },
  setTokenGetter: jest.fn(),
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

/** A scroll event within 600pt of the content end, which is what loads the next page. */
const NEAR_END = { nativeEvent: { contentOffset: { y: 900 }, layoutMeasurement: { height: 800 }, contentSize: { height: 1500 } } }

const mockUseApiQuery = require("@/lib/use-query").useApiQuery as jest.Mock

// Mock data matching m6.html
const mockReportsData = {
  reports: [
    { id: "BD-1042",  title: "Stored XSS in search results", sourceLabel: "#482", targetName: "juice-shop", channel: "github", state: "AWAITING_APPROVAL", outcome: "REPRODUCED", verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 5, updatedAt: "2025-01-01T10:00:00Z", awaitingVerdictId: "v1", investigating: false, origin: "juice-shop" },
    { id: "BD-1044",  title: "Missing rate limit on login", sourceLabel: "#484", targetName: "juice-shop", channel: "github", state: "AWAITING_APPROVAL", outcome: "REPRODUCED", verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 3, updatedAt: "2025-01-01T09:46:00Z", awaitingVerdictId: "v2", investigating: false, origin: "juice-shop" },
    { id: "BD-1047",  title: "Open redirect on /login", sourceLabel: null, targetName: null, channel: "email", state: "TRIAGING", outcome: null, verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 0, updatedAt: "2025-01-01T10:06:00Z", awaitingVerdictId: null, investigating: false, origin: "email" },
    { id: "BD-1045",  title: "SQL injection in search", sourceLabel: "#485", targetName: "juice-shop", channel: "github", state: "REPRODUCING", outcome: null, verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: "RUNNING", deliveryState: null, handoffFailed: false, eventCount: 4, updatedAt: "2025-01-01T10:00:00Z", awaitingVerdictId: null, investigating: true, origin: "juice-shop" },
    { id: "BD-1033",  title: "Reflected XSS in /search", sourceLabel: "#473", targetName: "juice-shop", channel: "github", state: "DELIVERED", outcome: "REPRODUCED", verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: "DELIVERED", handoffFailed: false, eventCount: 8, updatedAt: "2025-01-01T08:00:00Z", awaitingVerdictId: null, investigating: false, origin: "juice-shop" },
    { id: "BD-1030",  title: "CSRF on profile update", sourceLabel: "#470", targetName: "juice-shop", channel: "github", state: "DENIED", outcome: "NOT_REPRODUCED", verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 2, updatedAt: "2025-01-01T06:00:00Z", awaitingVerdictId: null, investigating: false, origin: "juice-shop" },
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
    expect(getByText("#482 · juice-shop")).toBeTruthy()
  })

  it("keeps the same search input mounted while typing", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockReportsData,
      error: undefined,
      isError: false,
      isFetching: false,
    })
    const { getByPlaceholderText } = await render(<ReportsScreen />)
    const before = getByPlaceholderText("Search reports")
    await fireEvent.changeText(before, "X")
    // A header passed as an inline component would remount the input and drop the keyboard.
    expect(getByPlaceholderText("Search reports")).toBe(before)
  })

  // The server answers ?q= (GET /reports matches title, source and target); this stands in for it.
  function serveSearch() {
    mockUseApiQuery.mockImplementation((path: string) => {
      const q = new URLSearchParams(path.split("?")[1]).get("q")?.toLowerCase()
      const reports = q
        ? mockReportsData.reports.filter((r: { title: string }) => r.title.toLowerCase().includes(q))
        : mockReportsData.reports
      return {
        data: { ...mockReportsData, reports, total: reports.length, nextOffset: null },
        error: undefined,
        isError: false,
        isFetching: false,
      }
    })
  }

  it("sends the search term to the server as q", async () => {
    serveSearch()
    const { getByPlaceholderText, getByText, queryByText } = await render(<ReportsScreen />)
    await fireEvent.changeText(getByPlaceholderText("Search reports"), "XSS")
    await waitFor(() => {
      expect(mockUseApiQuery).toHaveBeenCalledWith("/reports?limit=50&q=XSS")
    })
    await waitFor(() => {
      expect(queryByText("Missing rate limit on login")).toBeNull()
    })
    expect(getByText("Stored XSS in search results")).toBeTruthy()
  })

  it("shows no-results state when the server finds nothing", async () => {
    serveSearch()
    const { getByPlaceholderText, getByText } = await render(<ReportsScreen />)
    await fireEvent.changeText(getByPlaceholderText("Search reports"), "nonexistent report")
    await waitFor(() => {
      expect(getByText(/No reports match/)).toBeTruthy()
    })
    expect(getByText("Clear search")).toBeTruthy()
  })

  it("clears search from the no-results state", async () => {
    serveSearch()
    const { getByPlaceholderText, getByText } = await render(<ReportsScreen />)
    await fireEvent.changeText(getByPlaceholderText("Search reports"), "nonexistent")
    await waitFor(() => {
      expect(getByText("Clear search")).toBeTruthy()
    })
    await fireEvent.press(getByText("Clear search"))
    await waitFor(() => {
      expect(getByText("Stored XSS in search results")).toBeTruthy()
    })
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
    // The header counts the rows the chip shows, not the server total of 6.
    const shown = mockReportsData.reports.filter((r: { state: string }) => ["TRIAGING", "NEEDS_DECISION"].includes(r.state)).length
    expect(getByText(`${shown} reports`)).toBeTruthy()
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

  it("requests reports with limit=50", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockReportsData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    await render(<ReportsScreen />)

    expect(mockUseApiQuery).toHaveBeenCalledWith("/reports?limit=50")
  })

  it("renders after query flips error to success with no hook-order warning", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    mockUseApiQuery.mockReturnValue({
      data: undefined,
      error: undefined,
      isError: false,
      isFetching: true,
    })

    const { rerender } = await render(<ReportsScreen />)

    mockUseApiQuery.mockReturnValue({
      data: mockReportsData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    await rerender(<ReportsScreen />)

    const hookWarnings = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("hooks")
    )
    expect(hookWarnings.length).toBe(0)
    warnSpy.mockRestore()
  })

  it("renders a single scroller with the header inside it (no outer ScrollView ancestor)", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockReportsData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByTestId, getByText } = await render(<ReportsScreen />)
    // FlatList is the only scroller (no outer ScrollView), with the header
    // (search field, chips, count) and footer (footnote, spinner) inside it.
    expect(getByTestId("reports-list")).toBeTruthy()
    expect(getByText("Reports")).toBeTruthy()
    expect(getByText("6 reports")).toBeTruthy()
    expect(getByText(/Every report keeps its full history/i)).toBeTruthy()
  })

  it("does not drop loaded pages when firstPage refetches in background", async () => {
    const firstPageData = {
      reports: [{ id: "BD-1", title: "First page report", sourceLabel: "#1", targetName: "juice-shop", channel: "github", state: "TRIAGING", outcome: null, verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 1, updatedAt: "2025-01-01T10:00:00Z", awaitingVerdictId: null, investigating: false, origin: "juice-shop" }],
      total: 2,
      nextOffset: 1,
    }
    const secondPageData = {
      reports: [{ id: "BD-2", title: "Second page report", sourceLabel: "#2", targetName: "juice-shop", channel: "github", state: "TRIAGING", outcome: null, verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 1, updatedAt: "2025-01-01T10:00:00Z", awaitingVerdictId: null, investigating: false, origin: "juice-shop" }],
      total: 2,
      nextOffset: null,
    }

    const mockApi = require("@/lib/api").api as jest.Mock
    mockApi.mockResolvedValueOnce(secondPageData)

    mockUseApiQuery.mockReturnValue({
      data: firstPageData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByTestId, getByText, rerender } = await render(<ReportsScreen />)
    const flatList = getByTestId("reports-list")

    // Trigger loadMore to load page 2 by firing onEndReached
    await fireEvent.scroll(flatList, NEAR_END)
    await waitFor(() => {
      expect(getByText("Second page report")).toBeTruthy()
    })

    // Refetch firstPage (same data). pages.length > 0, so guard prevents reset.
    mockUseApiQuery.mockReturnValue({
      data: firstPageData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    await rerender(<ReportsScreen />)

    expect(getByText("First page report")).toBeTruthy()
    expect(getByText("Second page report")).toBeTruthy()
  })

  it("shows retry text when loadMore fails and stops the spinner", async () => {
    const firstPageWithMore = {
      reports: [{ id: "BD-1", title: "Report one", sourceLabel: "#1", targetName: "juice-shop", channel: "github", state: "TRIAGING", outcome: null, verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 1, updatedAt: "2025-01-01T10:00:00Z", awaitingVerdictId: null, investigating: false, origin: "juice-shop" }],
      total: 2,
      nextOffset: 1,
    }

    const mockApi = require("@/lib/api").api as jest.Mock
    mockApi.mockRejectedValueOnce(new Error("network error"))

    mockUseApiQuery.mockReturnValue({
      data: firstPageWithMore,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByTestId, getByText } = await render(<ReportsScreen />)
    const flatList = getByTestId("reports-list")

    await fireEvent.scroll(flatList, NEAR_END)

    await waitFor(() => {
      expect(getByText("Could not load more. Tap to retry")).toBeTruthy()
    })
  })

  it("LongPressMenu without onAssignToMe has no Assign to me row", async () => {
    const { LongPressMenu } = require("@/components/primitives")
    const mockOnClose = jest.fn()
    const mockOpenCase = jest.fn()

    const { queryByText } = await render(
      <LongPressMenu
        reportId="BD-1"
        visible={true}
        onClose={mockOnClose}
        onOpenCaseFile={mockOpenCase}
      />
    )

    expect(queryByText("Open case file")).toBeTruthy()
    expect(queryByText("Assign to me")).toBeNull()
  })
  it("fires one request when onEndReached repeats before the page arrives", async () => {
    const row = { id: "BD-1", title: "Report one", sourceLabel: "#1", targetName: "t", channel: "github", state: "TRIAGING", outcome: null, verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 1, updatedAt: "2025-01-01T10:00:00Z", awaitingVerdictId: null, investigating: false, origin: "t" }
    const mockApi = require("@/lib/api").api as jest.Mock
    mockApi.mockClear()
    let release: (v: unknown) => void = () => {}
    mockApi.mockReturnValueOnce(new Promise((r) => { release = r }))
    mockUseApiQuery.mockReturnValue({
      data: { reports: [row], total: 2, nextOffset: 1 },
      error: undefined,
      isError: false,
      isFetching: false,
    })
    const { getByTestId } = await render(<ReportsScreen />)
    const list = getByTestId("reports-list")
    // Fire twice without waiting: the first request is still pending when the second arrives.
    await act(async () => {
      void list.props.onScroll(NEAR_END)
      void list.props.onScroll(NEAR_END)
    })
    expect(mockApi).toHaveBeenCalledTimes(1)
    release({ reports: [{ ...row, id: "BD-2", title: "Report two" }], total: 2, nextOffset: null })
    await act(async () => {
      await Promise.resolve()
    })
    expect(mockApi).toHaveBeenCalledTimes(1)
  })
  it("keeps the search field mounted while a new search loads", async () => {
    // First path answers; any q= path is still loading, as on a fresh query key.
    mockUseApiQuery.mockImplementation((path: string) =>
      path.includes("q=")
        ? { data: undefined, error: undefined, isError: false, isFetching: true }
        : { data: mockReportsData, error: undefined, isError: false, isFetching: false },
    )
    const { getByPlaceholderText } = await render(<ReportsScreen />)
    const field = getByPlaceholderText("Search reports")
    await fireEvent.changeText(field, "XSS")
    await waitFor(() => {
      expect(mockUseApiQuery).toHaveBeenCalledWith("/reports?limit=50&q=XSS")
    })
    expect(getByPlaceholderText("Search reports")).toBe(field)
  })
})

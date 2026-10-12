/**
 * Render tests for M5 Queue.
 * Covers loading, data, and error states.
 */
import { render, fireEvent } from "@testing-library/react-native"
import * as Clipboard from "expo-clipboard"
import QueueScreen from "../app/(tabs)/queue"

const mockPush = jest.fn()
const mockBack = jest.fn()
const mockSetStringAsync = jest.fn()
;(Clipboard.setStringAsync as jest.Mock) = mockSetStringAsync

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

jest.mock("expo-linear-gradient", () => ({
  LinearGradient: ({ children }: { children: React.ReactNode }) => {
    const { View } = require("react-native")
    return require("react").createElement(View, { children })
  },
}))

const mockUseApiQuery = require("@/lib/use-query").useApiQuery as jest.Mock

// Mock data matching m5.html exactly
const mockQueueData = {
  columns: [
    {
      key: "awaiting-approval",
      label: "Awaiting approval",
      total: 3,
      cards: [
        { id: "BD-1042",  title: "Stored XSS in search results", sourceLabel: "#482", targetName: "juice-shop", channel: "github", state: "AWAITING_APPROVAL", outcome: "REPRODUCED", verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 5, updatedAt: "2025-01-01T10:00:00Z", ageLabel: "12 min", awaitingVerdictId: "v1", investigating: false },
        { id: "BD-1044",  title: "Missing rate limit on login", sourceLabel: "#484", targetName: "juice-shop", channel: "github", state: "AWAITING_APPROVAL", outcome: "REPRODUCED", verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 3, updatedAt: "2025-01-01T09:46:00Z", ageLabel: "34 min", awaitingVerdictId: "v2", investigating: false },
        { id: "BD-1043",  title: "Directory listing exposes /ftp", sourceLabel: "#483", targetName: "juice-shop", channel: "github", state: "AWAITING_APPROVAL", outcome: "REPRODUCED", verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 2, updatedAt: "2025-01-01T09:32:00Z", ageLabel: "48 min", awaitingVerdictId: "v3", investigating: false },
      ],
      nextOffset: null,
    },
    {
      key: "analysis-only",
      label: "Analysis only",
      total: 3,
      cards: [
        { id: "BD-1045",  title: "SQL injection in search", sourceLabel: "#485", targetName: "juice-shop", channel: "github", state: "REPRODUCING", outcome: null, verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: "RUNNING", deliveryState: null, handoffFailed: false, eventCount: 4, updatedAt: "2025-01-01T10:00:00Z", ageLabel: "12 min", awaitingVerdictId: null, investigating: true },
        { id: "BD-1041",  title: "SQL injection in login", sourceLabel: "#481", targetName: "juice-shop", channel: "github", state: "REPRODUCING", outcome: null, verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 1, updatedAt: "2025-01-01T09:00:00Z", ageLabel: "1 h", awaitingVerdictId: null, investigating: false },
        { id: "BD-1039",  title: "Open redirect on /redirect", sourceLabel: "#479", targetName: "juice-shop", channel: "advisory", state: "ANALYSIS_ONLY", outcome: null, verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 0, updatedAt: "2025-01-01T07:00:00Z", ageLabel: "3 h", awaitingVerdictId: null, investigating: false },
      ],
      nextOffset: null,
    },
    {
      key: "triaging",
      label: "Triaging",
      total: 2,
      cards: [
        { id: "BD-1047",  title: "Open redirect on /login", sourceLabel: null, targetName: null, channel: "email", state: "TRIAGING", outcome: null, verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 0, updatedAt: "2025-01-01T10:06:00Z", ageLabel: "4 min", awaitingVerdictId: null, investigating: false },
        { id: "BD-1037",  title: "Weak JWT secret", sourceLabel: "#477", targetName: "juice-shop", channel: "github", state: "TRIAGING", outcome: null, verdictSuperseded: false, jobDeadLettered: false, sessionErrored: false, runStatus: null, deliveryState: null, handoffFailed: false, eventCount: 0, updatedAt: "2025-01-01T00:00:00Z", ageLabel: "Yesterday", awaitingVerdictId: null, investigating: false },
      ],
      nextOffset: null,
    },
  ],
}

describe("M5 Queue", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders the queue title and open reports count", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockQueueData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<QueueScreen />)

    expect(getByText("Queue")).toBeTruthy()
    expect(getByText("8 open reports")).toBeTruthy()
  })

  it("renders all four phase sections with counts", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockQueueData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<QueueScreen />)

    expect(getByText("Awaiting approval")).toBeTruthy()
    expect(getByText("Analysis only")).toBeTruthy()
    expect(getByText("Reproducing")).toBeTruthy()
    expect(getByText("Triaging")).toBeTruthy()
  })

  it("renders the footnote", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockQueueData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<QueueScreen />)

    expect(getByText(/Reports wait at each phase/i)).toBeTruthy()
  })

  it("renders report titles and subtitles", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockQueueData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<QueueScreen />)

    expect(getByText("Stored XSS in search results")).toBeTruthy()
    expect(getByText("#482 · juice-shop")).toBeTruthy()
  })

  it("shows Running for investigating reports", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockQueueData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<QueueScreen />)

    expect(getByText("Running")).toBeTruthy()
  })

  it("renders loading state while fetching", async () => {
    mockUseApiQuery.mockReturnValue({
      data: undefined,
      error: undefined,
      isError: false,
      isFetching: true,
    })

    const { toJSON } = await render(<QueueScreen />)
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

    const { getByText } = await render(<QueueScreen />)
    expect(getByText(/upstream timeout/i)).toBeTruthy()
  })

  it("splits the analysis-only column into Reproducing and Analysis only", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockQueueData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<QueueScreen />)

    expect(getByText("SQL injection in search")).toBeTruthy()
    expect(getByText("SQL injection in login")).toBeTruthy()
    expect(getByText("Open redirect on /redirect")).toBeTruthy()
  })

  it("falls back to the channel name when a report has no target", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockQueueData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<QueueScreen />)

    expect(getByText("BD-1047 · email")).toBeTruthy()
    expect(getByText("#479 · juice-shop")).toBeTruthy()
  })

  it("renders data without a hook-order warning", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    mockUseApiQuery.mockReturnValue({
      data: mockQueueData,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    await render(<QueueScreen />)

    const hookWarnings = warnSpy.mock.calls.filter((c) => c[0]?.includes?.("hooks") || c[0]?.includes?.("unmounted"))
    expect(hookWarnings.length).toBe(0)
    warnSpy.mockRestore()
  })
  it("counts from the server total when a column is paged short", async () => {
    const paged = {
      ...mockQueueData,
      columns: mockQueueData.columns.map((c: { key: string }) =>
        c.key === "awaiting-approval" ? { ...c, total: 25 } : c,
      ),
    }
    mockUseApiQuery.mockReturnValue({ data: paged, error: undefined, isError: false, isFetching: false })
    const { getByText } = await render(<QueueScreen />)
    expect(getByText("25")).toBeTruthy()
    expect(mockUseApiQuery).toHaveBeenCalledWith("/queue?limit=50")
  })
  it("notes a short shared column once instead of marking each split section", async () => {
    const paged = {
      ...mockQueueData,
      columns: mockQueueData.columns.map((c: { key: string; cards: unknown[] }) =>
        c.key === "analysis-only" ? { ...c, total: c.cards.length + 30 } : c,
      ),
    }
    mockUseApiQuery.mockReturnValue({ data: paged, error: undefined, isError: false, isFetching: false })
    const { getByText, queryAllByText } = await render(<QueueScreen />)
    expect(getByText(/^Showing the newest \d+ of \d+ reproducing and analysis-only reports\.$/)).toBeTruthy()
    expect(queryAllByText(/\+$/)).toHaveLength(0)
  })
})

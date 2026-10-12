/**
 * Render tests for M7 Case file.
 * Covers loading, data, and error states.
 */
import { render, fireEvent } from "@testing-library/react-native"
import CaseFileScreen from "../app/reports/[id]/index"

const mockPush = jest.fn()
const mockBack = jest.fn()

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
  useLocalSearchParams: () => ({ id: "BD-1042" }),
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
    phase: {
      triaging: "#6366f1",
      reproducing: "#3b82f6",
      analysis: "#ec4899",
      approval: "#f59e0b",
      delivered: "#22c55e",
      closed: "#9ca3af",
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

jest.mock("@/components/icons", () => ({
  Icon: ({ name }: { name: string }) => {
    const { Text } = require("react-native")
    const { createElement } = require("react")
    return createElement(Text, { children: `icon-${name}` })
  },
}))

const mockUseApiQuery = require("@/lib/use-query").useApiQuery as jest.Mock

// Mock data matching m7.html exactly
const mockCaseFile = {
  id: "BD-1042",
  title: "Stored XSS in search results",
  issueNumber: 482,
  sourceLabel: "#482",
  channel: "github",
  deliveryChannel: "github",
  repositoryFullName: "Vaibhav91one/juice-shop",
  reporterHandle: "@sec-researcher",
  createdAt: "2025-01-01T10:00:00Z",
  updatedAt: "2025-01-01T10:12:00Z",
  state: "AWAITING_APPROVAL",
  stateLabel: "Awaiting approval",
  phase: "awaiting-approval",
  investigating: false,
  failed: false,
  target: { id: "t1", name: "Vaibhav91one/juice-shop", imageDigest: "1867b926c5f50e4e692dc9c8f61821413cebe0cd" },
  targetScope: {
    imageDigest: "1867b926c5f50e4e692dc9c8f61821413cebe0cd",
    snapshotId: "snap1",
    buildMarker: "v17.3.0",
    scopeRules: [],
    readinessPath: "/health",
    startCommand: null,
    egress: "none",
  },
  summary: "The search parameter is stored and rendered without encoding. The canary payload executed in the reproduction sandbox.",
  destination: "github:123:issue:482",
  verdict: {
    id: "v1",
    revision: 1,
    outcome: "REPRODUCED",
    outcomeLabel: "Reproduced",
    summary: "The search parameter is stored and rendered without encoding.",
    payload: "This is a stored XSS in the search results page. The search parameter is rendered without encoding via bypassSecurityTrustHtml.",
    contentHash: "abc123",
    superseded: false,
    findings: [
      { title: "Unencoded query parameter", severity: "high", description: "The search param is rendered without encoding", evidenceRef: "search.component.ts", cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N" },
      { title: "Canary executed in sandbox", severity: "high", description: "Confirmed reproduction", evidenceRef: "Reproduction run 1 of 1", cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N" },
      { title: "No output encoding on render", severity: "medium", description: "Angular bypassSecurityTrustHtml", evidenceRef: "Angular bypassSecurityTrustHtml", cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N" },
    ],
  },
  awaitingVerdictId: "v1",
  approval: null,
  delivery: null,
  events: [
    { seq: 1, type: "intake", channel: "github", at: "2025-01-01T10:00:00Z", toolName: null, argsPreview: null },
    { seq: 2, type: "sandbox", channel: "sandbox", at: "2025-01-01T10:02:00Z", toolName: "probe_target", argsPreview: null },
    { seq: 3, type: "analysis", channel: "agent", at: "2025-01-01T10:10:00Z", toolName: null, argsPreview: null },
    { seq: 4, type: "verdict", channel: "agent", at: "2025-01-01T10:11:00Z", toolName: null, argsPreview: null },
    { seq: 5, type: "approval", channel: "approval", at: "2025-01-01T10:12:00Z", toolName: null, argsPreview: null },
  ],
  toolCalls: [
    { seq: 2, type: "agent.tool_call:probe_target", channel: "agent", at: "2025-01-01T10:02:00Z", toolName: "probe_target", argsPreview: "{}" },
    { seq: 3, type: "agent.tool_call:search", channel: "agent", at: "2025-01-01T10:05:00Z", toolName: "search", argsPreview: "{}" },
    { seq: 4, type: "agent.tool_call:search", channel: "agent", at: "2025-01-01T10:06:00Z", toolName: "search", argsPreview: "{}" },
    { seq: 5, type: "agent.tool_call:search", channel: "agent", at: "2025-01-01T10:07:00Z", toolName: "search", argsPreview: "{}" },
    { seq: 6, type: "agent.tool_call:write_file", channel: "agent", at: "2025-01-01T10:08:00Z", toolName: "write_file", argsPreview: "{}" },
    { seq: 7, type: "agent.tool_call:search", channel: "agent", at: "2025-01-01T10:09:00Z", toolName: "search", argsPreview: "{}" },
    { seq: 8, type: "agent.tool_call:search", channel: "agent", at: "2025-01-01T10:09:30Z", toolName: "search", argsPreview: "{}" },
    { seq: 9, type: "agent.tool_call:search", channel: "agent", at: "2025-01-01T10:10:00Z", toolName: "search", argsPreview: "{}" },
    { seq: 10, type: "agent.tool_call:search", channel: "agent", at: "2025-01-01T10:10:30Z", toolName: "search", argsPreview: "{}" },
    { seq: 11, type: "agent.tool_call:search", channel: "agent", at: "2025-01-01T10:11:00Z", toolName: "search", argsPreview: "{}" },
    { seq: 12, type: "agent.tool_call:search", channel: "agent", at: "2025-01-01T10:11:30Z", toolName: "search", argsPreview: "{}" },
    { seq: 13, type: "agent.tool_call:search", channel: "agent", at: "2025-01-01T10:11:45Z", toolName: "search", argsPreview: "{}" },
    { seq: 14, type: "agent.tool_call:search", channel: "agent", at: "2025-01-01T10:11:50Z", toolName: "search", argsPreview: "{}" },
  ],
  appeals: [],
}

describe("M7 Case file", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders the report title as h1", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockCaseFile,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<CaseFileScreen />)
    expect(getByText("Stored XSS in search results")).toBeTruthy()
  })

  it("renders the phase pill and report id with opened age", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockCaseFile,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<CaseFileScreen />)
    expect(getByText("Awaiting approval")).toBeTruthy()
    expect(getByText(/#482 · opened/)).toBeTruthy()
  })

  it("renders the Report section with Severity, Channel, Reporter", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockCaseFile,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText, getAllByText } = await render(<CaseFileScreen />)
    expect(getByText("Report")).toBeTruthy()
    expect(getByText("Severity")).toBeTruthy()
    expect(getAllByText("High").length).toBeGreaterThan(0)
    expect(getByText("Channel")).toBeTruthy()
    expect(getByText("Reporter")).toBeTruthy()
  })

  it("renders the Bound target section with target name and Verified pill", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockCaseFile,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<CaseFileScreen />)
    expect(getByText("Bound target")).toBeTruthy()
    expect(getByText("Vaibhav91one/juice-shop")).toBeTruthy()
    expect(getByText("Verified")).toBeTruthy()
  })

  it("renders unbound target card without a press handler", async () => {
    const unboundCaseFile = {
      ...mockCaseFile,
      target: null,
      targetScope: null,
    }
    mockUseApiQuery.mockReturnValue({
      data: unboundCaseFile,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<CaseFileScreen />)
    expect(getByText("Bound target")).toBeTruthy()
    expect(getByText("No target bound")).toBeTruthy()
    // The unbound text should NOT navigate — verify no push was called
    mockPush.mockClear()
    fireEvent.press(getByText("No target bound"))
    expect(mockPush).not.toHaveBeenCalled()
  })

  it("words the channel, the target version and short commit, and counts only tool calls", async () => {
    mockUseApiQuery.mockReturnValue({
      data: {
        ...mockCaseFile,
        targetVersion: "v17.3.0",
        targetScope: { ...mockCaseFile.targetScope, buildMarker: "bd-build-1867b92-ok" },
        toolCalls: [
          ...mockCaseFile.toolCalls.slice(0, 5),
          { seq: 99, type: "agent.scope_tool_denied", channel: "agent", at: "2025-01-01T10:12:00Z", toolName: "probe_target", argsPreview: null },
        ],
      },
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<CaseFileScreen />)
    expect(getByText("GitHub issue")).toBeTruthy()
    expect(getByText("v17.3.0 · 1867b92")).toBeTruthy()
    expect(getByText("5 calls")).toBeTruthy()
  })

  it("renders the Agent summary section", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockCaseFile,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<CaseFileScreen />)
    expect(getByText("Agent summary")).toBeTruthy()
    expect(getByText(/The search parameter is stored and rendered without encoding/i)).toBeTruthy()
  })

  it("renders the Findings section with finding titles and severities", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockCaseFile,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<CaseFileScreen />)
    expect(getByText("Findings")).toBeTruthy()
    expect(getByText("Unencoded query parameter")).toBeTruthy()
    expect(getByText("Canary executed in sandbox")).toBeTruthy()
    expect(getByText("No output encoding on render")).toBeTruthy()
  })

  it("renders the Explore section with quick-link tiles", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockCaseFile,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<CaseFileScreen />)
    expect(getByText("Explore")).toBeTruthy()
    expect(getByText("Timeline")).toBeTruthy()
    expect(getByText("5 events")).toBeTruthy()
    expect(getByText("Tool calls")).toBeTruthy()
    expect(getByText("13 calls")).toBeTruthy()
    expect(getByText("Sandbox")).toBeTruthy()
    expect(getByText("Chat")).toBeTruthy()
  })

  it("renders the floating bar with Open verdict button", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockCaseFile,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<CaseFileScreen />)
    expect(getByText("Open verdict")).toBeTruthy()
  })

  it("navigates to chat when a tile is pressed", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockCaseFile,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<CaseFileScreen />)
    fireEvent.press(getByText("Chat"))
    expect(mockPush).toHaveBeenCalledWith("/reports/BD-1042/chat")
  })

  it("navigates to sign-the-verdict when Open verdict is pressed", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockCaseFile,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<CaseFileScreen />)
    fireEvent.press(getByText("Open verdict"))
    expect(mockPush).toHaveBeenCalledWith("/reports/BD-1042/sign-the-verdict")
  })

  it("navigates to target-and-scope when the bound target is pressed", async () => {
    mockUseApiQuery.mockReturnValue({
      data: mockCaseFile,
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { getByText } = await render(<CaseFileScreen />)
    fireEvent.press(getByText("Vaibhav91one/juice-shop"))
    expect(mockPush).toHaveBeenCalledWith("/reports/BD-1042/target-and-scope")
  })

  it("renders loading state while fetching", async () => {
    mockUseApiQuery.mockReturnValue({
      data: undefined,
      error: undefined,
      isError: false,
      isFetching: true,
    })

    const { getByText } = await render(<CaseFileScreen />)
    expect(getByText("Loading case file")).toBeTruthy()
  })

  it("renders error message on non-auth error", async () => {
    const { ApiError } = require("@/lib/use-query")
    mockUseApiQuery.mockReturnValue({
      data: undefined,
      error: new ApiError(500, "err-server", "upstream timeout"),
      isError: true,
      isFetching: false,
    })

    const { getByText } = await render(<CaseFileScreen />)
    expect(getByText(/upstream timeout/i)).toBeTruthy()
  })

  it("renders no findings section when verdict has no findings", async () => {
    mockUseApiQuery.mockReturnValue({
      data: { ...mockCaseFile, verdict: { ...mockCaseFile.verdict, findings: [] } },
      error: undefined,
      isError: false,
      isFetching: false,
    })

    const { queryByText } = await render(<CaseFileScreen />)
    expect(queryByText("Findings")).toBeNull()
  })
})
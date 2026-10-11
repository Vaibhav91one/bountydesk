/**
 * M9 Tool calls render tests: loading, data, and empty states.
 */
import React from "react"
import { render } from "@testing-library/react-native"

import ToolCallsScreen from "../app/reports/[id]/tool-calls"
import { MobileCaseFile } from "@/lib/types"
import { PhaseKey } from "@/lib/phases"

const mockPush = jest.fn()
const mockBack = jest.fn()

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "report-1" }),
  useRouter: () => ({ push: mockPush, back: mockBack }),
}))

const mockQueryData: Record<string, unknown> = {}
jest.mock("@/lib/use-query", () => ({
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, code?: string, message?: string) {
      super(message ?? `API error: ${status}`)
      this.status = status
    }
  },
  useApiQuery: (path: string) => {
    const data = mockQueryData[path] as { data?: MobileCaseFile; error?: Error }
    return {
      data: data?.data,
      error: data?.error,
      isError: !!data?.error,
    }
  },
  useApiMutation: () => ({
    mutate: jest.fn(),
    isPending: false,
  }),
}))

jest.mock("@/theme", () => ({
  useTheme: () => ({
    colors: {
      page: "#0b0b0d",
      background: "#15161a",
      card: "#1c1d21",
      foreground: "#f5f5f7",
      muted: "#a0a0b0",
      faint: "#606070",
      red: "#e74055",
      brand: "#8a2be2",
      "brand-soft": "#a080d0",
      glass: "rgba(15,15,17,0.6)",
      "glass-edge": "rgba(255,255,255,0.10)",
    },
    phase: {
      triaging: "#aa55ff",
      reproducing: "#4da6ff",
      analysis: "#d14fcf",
      approval: "#e6c100",
      delivered: "#4caf50",
      closed: "#888888",
    } as Record<PhaseKey, string>,
    typography: { fontFamily: "Inter", fontMono: "GeistMono" },
  }),
}))

jest.mock("@/components/primitives", () => {
  const { View: RNView, Text: RNText } = require("react-native")
  return {
    ScreenHeader: ({ title, meta, back }: { title: string; meta?: string; back?: boolean }) => (
      <RNView><RNText>{title}</RNText>{meta ? <RNText>{meta}</RNText> : null}{back ? <RNText>Back</RNText> : null}</RNView>
    ),
    EmptyState: ({ heading, body }: { heading: string; body?: string }) => (
      <RNView><RNText>{heading}</RNText>{body ? <RNText>{body}</RNText> : null}</RNView>
    ),
  }
})

jest.mock("@/components/ui/Pill", () => {
  const { View: RNView, Text: RNText } = require("react-native")
  return {
    Pill: ({ label }: { label?: string; color: string; style?: any }) => (
      <RNView><RNText>{label}</RNText></RNView>
    ),
  }
})

const SAMPLE_REPORT: MobileCaseFile = {
  id: "report-1",
  title: "Stored XSS in search results",
  issueNumber: 214,
  sourceLabel: "github",
  channel: "github",
  deliveryChannel: null,
  repositoryFullName: "Vaibhav91one/juice-shop",
  reporterHandle: "sec-researcher",
  createdAt: "2026-01-01T09:14:02Z",
  updatedAt: "2026-01-01T09:16:21Z",
  state: "AWAITING_APPROVAL",
  stateLabel: "Awaiting approval",
  phase: "approval",
  investigating: false,
  failed: false,
  target: { id: "tgt-1", name: "juice-shop", imageDigest: "sha256:abc123" },
  summary: null,
  destination: "",
  verdict: null,
  awaitingVerdictId: null,
  approval: null,
  delivery: null,
  events: [
    { seq: 10, type: "agent.scope_tool_denied", channel: "agent", at: "2026-01-01T09:14:35Z", toolName: "probe_browser", argsPreview: null },
    { seq: 12, type: "agent.scope_tool_denied", channel: "agent", at: "2026-01-01T09:14:55Z", toolName: "probe_target", argsPreview: null },
  ],
  toolCalls: [
    { seq: 0, type: "agent.tool_call:scope_check", channel: "agent", at: "2026-01-01T09:14:12Z", toolName: "scope_check", argsPreview: "target=juice-shop@1867b92" },
    { seq: 1, type: "agent.tool_call:probe_target", channel: "agent", at: "2026-01-01T09:14:41Z", toolName: "probe_target", argsPreview: "GET /rest/products/search?q=canary" },
    { seq: 2, type: "agent.tool_call:probe_target", channel: "agent", at: "2026-01-01T09:14:50Z", toolName: "probe_target", argsPreview: "GET https://example.com/collect" },
    { seq: 3, type: "agent.tool_call:probe_target_write", channel: "agent", at: "2026-01-01T09:15:03Z", toolName: "probe_target_write", argsPreview: 'POST /api/Feedbacks {comment:"canary"}' },
    { seq: 4, type: "agent.tool_call:probe_browser", channel: "agent", at: "2026-01-01T09:15:10Z", toolName: "probe_browser", argsPreview: "navigate /#/search?q=canary" },
    { seq: 5, type: "agent.tool_call:publish_verdict", channel: "agent", at: "2026-01-01T09:16:20Z", toolName: "publish_verdict", argsPreview: null },
  ],
  appeals: [],
}

describe("M9 Tool calls", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders the screen title in loading state", async () => {
    mockQueryData["/reports/report-1"] = {}
    const { getByText } = await render(<ToolCallsScreen />)
    expect(getByText("Tool calls")).toBeTruthy()
    expect(getByText("Back")).toBeTruthy()
  })

  it("renders tool calls grouped into sections with status pills", async () => {
    mockQueryData["/reports/report-1"] = { data: SAMPLE_REPORT }
    const { getByText, getAllByText } = await render(<ToolCallsScreen />)
    expect(getByText("Tool calls")).toBeTruthy()
    expect(getByText(/report-1 · 6 calls/)).toBeTruthy()
    expect(getByText("Investigation")).toBeTruthy()
    expect(getByText("Human gate")).toBeTruthy()
    // Tool names
    expect(getByText("scope_check")).toBeTruthy()
    expect(getAllByText("probe_target").length).toBeGreaterThanOrEqual(1)
    // Status pills
    expect(getByText("Pass")).toBeTruthy()
    expect(getAllByText("Allowed").length).toBeGreaterThanOrEqual(1)
    expect(getByText("Gated")).toBeTruthy()
    expect(getAllByText("Denied").length).toBeGreaterThanOrEqual(1)
    // Note
    expect(getByText(/server-held profile/)).toBeTruthy()
  })

  it("header count excludes scope_tool_denied events and shows per-call status", async () => {
    const reportWithDenial: MobileCaseFile = {
      ...SAMPLE_REPORT,
      events: [
        { seq: 0, type: "agent.tool_call:scope_check", channel: "agent", at: "2026-01-01T09:14:12Z", toolName: "scope_check", argsPreview: "target=juice-shop" },
        { seq: 1, type: "agent.tool_call:probe_target", channel: "agent", at: "2026-01-01T09:14:41Z", toolName: "probe_target", argsPreview: "GET /q=canary" },
        { seq: 2, type: "agent.tool_call:probe_target", channel: "agent", at: "2026-01-01T09:14:50Z", toolName: "probe_target", argsPreview: "GET /q=second" },
        { seq: 10, type: "agent.scope_tool_denied", channel: "agent", at: "2026-01-01T09:14:55Z", toolName: "probe_target", argsPreview: null },
      ],
      toolCalls: [
        { seq: 0, type: "agent.tool_call:scope_check", channel: "agent", at: "2026-01-01T09:14:12Z", toolName: "scope_check", argsPreview: "target=juice-shop" },
        { seq: 1, type: "agent.tool_call:probe_target", channel: "agent", at: "2026-01-01T09:14:41Z", toolName: "probe_target", argsPreview: "GET /q=canary" },
        { seq: 2, type: "agent.tool_call:probe_target", channel: "agent", at: "2026-01-01T09:14:50Z", toolName: "probe_target", argsPreview: "GET /q=second" },
        { seq: 5, type: "agent.tool_call:publish_verdict", channel: "agent", at: "2026-01-01T09:16:20Z", toolName: "publish_verdict", argsPreview: null },
      ],
    }
    mockQueryData["/reports/report-1"] = { data: reportWithDenial }
    const { getByText, getAllByText } = await render(<ToolCallsScreen />)
    // 4 actual calls (scope_check + 2 probe_target + publish_verdict), denial excluded
    expect(getByText(/report-1 · 4 calls/)).toBeTruthy()
    expect(getByText("Denied")).toBeTruthy()
  })

  it("renders an empty state when there are no tool calls", async () => {
    const emptyReport: MobileCaseFile = { ...SAMPLE_REPORT, toolCalls: [] }
    mockQueryData["/reports/report-1"] = { data: emptyReport }
    const { getByText } = await render(<ToolCallsScreen />)
    expect(getByText("No tool calls")).toBeTruthy()
  })
})

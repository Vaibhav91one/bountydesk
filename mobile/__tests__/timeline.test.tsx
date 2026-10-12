/**
 * M8 Timeline render tests: loading, data, and empty states.
 */
import React from "react"
import { render } from "@testing-library/react-native"
const { Text, View } = require("react-native")

import TimelineScreen from "../app/reports/[id]/timeline"
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
    ScreenHeader: ({ back }: { back?: boolean }) => <RNView>{back ? <RNText>Back</RNText> : null}</RNView>,
    ScreenTitle: ({ title, meta }: { title: string; meta?: string }) => (
      <RNView><RNText>{title}</RNText>{meta ? <RNText>{meta}</RNText> : null}</RNView>
    ),
    PhasePill: ({ label }: { label?: string }) => <RNText>{label}</RNText>,
    EmptyState: ({ heading, body }: { heading: string; body?: string }) => (
      <RNView><RNText>{heading}</RNText>{body ? <RNText>{body}</RNText> : null}</RNView>
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
    { seq: 0, type: "intake.accepted", channel: "intake", at: "2026-01-01T09:14:02Z", toolName: null, argsPreview: null },
    { seq: 1, type: "analysis.stub_session.created", channel: "analysis", at: "2026-01-01T09:14:09Z", toolName: null, argsPreview: null },
    { seq: 2, type: "agent.tool_call:scope_check", channel: "agent", at: "2026-01-01T09:14:12Z", toolName: "scope_check", argsPreview: "target=juice-shop@1867b92" },
    { seq: 3, type: "agent.tool_call:probe_target", channel: "agent", at: "2026-01-01T09:14:41Z", toolName: "probe_target", argsPreview: "GET /rest/products/search?q=canary, 200" },
  ],
  toolCalls: [],
  appeals: [],
}

describe("M8 Timeline", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders the screen title and back button in loading state", async () => {
    mockQueryData["/reports/report-1"] = {}
    const { getByText } = await render(<TimelineScreen />)
    expect(getByText("Timeline")).toBeTruthy()
    expect(getByText("Back")).toBeTruthy()
  })

  it("renders timeline events with labels and UTC times", async () => {
    mockQueryData["/reports/report-1"] = { data: SAMPLE_REPORT }
    const { getByText } = await render(<TimelineScreen />)
    // Header
    expect(getByText("Timeline")).toBeTruthy()
    // Meta line
    expect(getByText("github · 4 events in 39 s")).toBeTruthy()
    // Event labels derived from type
    expect(getByText("Received")).toBeTruthy()
    expect(getByText("Session created")).toBeTruthy()
    expect(getByText("Scope check")).toBeTruthy()
    expect(getByText("Probe")).toBeTruthy()
    // Footnote
    expect(getByText(/Times are UTC/)).toBeTruthy()
  })

  it("labels parsed and approval-requested events and words the span", async () => {
    mockQueryData["/reports/report-1"] = {
      data: {
        ...SAMPLE_REPORT,
        events: [
          { seq: 1, type: "intake.parsed", channel: "intake", at: "2026-01-01T09:14:03Z", toolName: null, argsPreview: null },
          { seq: 2, type: "approval.requested", channel: "approval", at: "2026-01-01T09:16:22Z", toolName: null, argsPreview: null },
        ],
      },
    }
    const { getByText } = await render(<TimelineScreen />)
    expect(getByText("Parsed")).toBeTruthy()
    expect(getByText("Awaiting approval")).toBeTruthy()
    expect(getByText("github · 2 events in 2 min 19 s")).toBeTruthy()
  })

  it("renders an empty state when there are no events", async () => {
    const emptyReport: MobileCaseFile = { ...SAMPLE_REPORT, events: [] }
    mockQueryData["/reports/report-1"] = { data: emptyReport }
    const { getByText } = await render(<TimelineScreen />)
    expect(getByText("No events")).toBeTruthy()
  })

  it("renders a scope_tool_denied event as Denied: <toolName>", async () => {
    const reportWithDenial: MobileCaseFile = {
      ...SAMPLE_REPORT,
      events: [
        { seq: 0, type: "agent.tool_call:probe_target", channel: "agent", at: "2026-01-01T09:14:41Z", toolName: "probe_target", argsPreview: "GET /rest/products?q=canary" },
        { seq: 5, type: "agent.scope_tool_denied", channel: "agent", at: "2026-01-01T09:14:45Z", toolName: "probe_target", argsPreview: null },
      ],
    }
    mockQueryData["/reports/report-1"] = { data: reportWithDenial }
    const { getByText } = await render(<TimelineScreen />)
    expect(getByText("Denied: probe_target")).toBeTruthy()
  })
})

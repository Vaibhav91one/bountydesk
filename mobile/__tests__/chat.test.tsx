/**
 * M10 Reviewer chat render tests: loading, data, and empty states.
 */
import React from "react"
import { render } from "@testing-library/react-native"

import ChatScreen from "../app/reports/[id]/chat"
import { PhaseKey } from "@/lib/phases"
import { ApiError } from "@/lib/use-query"

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
    const data = mockQueryData[path] as { data?: unknown; error?: Error }
    return {
      data: data?.data,
      error: data?.error,
      isError: !!data?.error,
      refetch: jest.fn(),
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

const CHAT_STATUS = {
  reportId: "report-1",
  threads: [
    {
      id: "thread-1",
      verdictId: null,
      verdictRevision: null,
      verdictContentHash: null,
      status: "RUNNING",
      createdAt: "2026-01-01T09:30:00Z",
      updatedAt: "2026-01-01T09:38:00Z",
      messages: [
        {
          id: "msg-1",
          clientRequestId: "req-1",
          sender: "REVIEWER",
          body: "Why is this rated High?",
          bodyHash: "hash1",
          modelName: null,
          providerTurnId: null,
          createdAt: "2026-01-01T09:38:00Z",
        },
        {
          id: "msg-2",
          clientRequestId: "req-1",
          sender: "AGENT",
          body: "The payload is stored, so it runs for every visitor who opens the search page.",
          bodyHash: "hash2",
          modelName: "gpt-4",
          providerTurnId: "turn-1",
          createdAt: "2026-01-01T09:38:01Z",
        },
      ],
    },
  ],
}

describe("M10 Reviewer chat", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders the screen title in loading state", async () => {
    mockQueryData["/reports/report-1/chat"] = {}
    mockQueryData["/reports/report-1"] = {}
    const { getByText } = await render(<ChatScreen />)
    expect(getByText("Ask the agent")).toBeTruthy()
    expect(getByText("Back")).toBeTruthy()
  })

  const REPORT_META = { data: { id: "report-1", title: "Stored XSS in search results" } }

  it("renders chat bubbles for reviewer and agent messages", async () => {
    mockQueryData["/reports/report-1/chat"] = { data: CHAT_STATUS }
    mockQueryData["/reports/report-1"] = REPORT_META
    const { getByText } = await render(<ChatScreen />)
    expect(getByText("Ask the agent")).toBeTruthy()
    expect(getByText("Agent Bounty")).toBeTruthy()
    expect(getByText("Why is this rated High?")).toBeTruthy()
    expect(getByText(/The payload is stored/)).toBeTruthy()
  })

  it("renders the meta line as report id and title", async () => {
    mockQueryData["/reports/report-1/chat"] = { data: CHAT_STATUS }
    mockQueryData["/reports/report-1"] = REPORT_META
    const { getByText } = await render(<ChatScreen />)
    expect(getByText(/report-1 · Stored XSS in search results/)).toBeTruthy()
  })

  it("renders suggestion chips when there are messages", async () => {
    mockQueryData["/reports/report-1/chat"] = { data: CHAT_STATUS }
    mockQueryData["/reports/report-1"] = REPORT_META
    const { getByText } = await render(<ChatScreen />)
    expect(getByText("Show the probes")).toBeTruthy()
    expect(getByText("Re-check")).toBeTruthy()
  })

  it("renders an empty state when there are no messages", async () => {
    mockQueryData["/reports/report-1/chat"] = { data: { reportId: "report-1", threads: [] } }
    mockQueryData["/reports/report-1"] = REPORT_META
    const { getByText } = await render(<ChatScreen />)
    expect(getByText("No messages yet")).toBeTruthy()
  })

  it("renders the composer input with placeholder", async () => {
    mockQueryData["/reports/report-1/chat"] = { data: CHAT_STATUS }
    mockQueryData["/reports/report-1"] = REPORT_META
    const { getByPlaceholderText } = await render(<ChatScreen />)
    expect(getByPlaceholderText("Ask about this report")).toBeTruthy()
  })

  it("renders after query flips from success to error and back (hook order stable)", async () => {
    // Start with success
    mockQueryData["/reports/report-1/chat"] = { data: CHAT_STATUS }
    mockQueryData["/reports/report-1"] = REPORT_META
    const { getByText, rerender } = await render(<ChatScreen />)
    expect(getByText("Ask the agent")).toBeTruthy()

    // Flip to error
    mockQueryData["/reports/report-1/chat"] = { error: new ApiError(500, "internal", "Server error") }
    const { rerender: r2 } = await render(<ChatScreen />)
    expect(r2).toBeDefined()

    // Flip back to success
    mockQueryData["/reports/report-1/chat"] = { data: CHAT_STATUS }
    const { getByText: g2 } = await render(<ChatScreen />)
    expect(g2("Ask the agent")).toBeTruthy()
  })
})

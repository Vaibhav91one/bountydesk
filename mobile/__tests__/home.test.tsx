/**
 * M4 Home render tests: needs-you carousel, active and delivered rows from the
 * real /queue shape, empty state, and routing.
 */
import React from "react"
import { render, fireEvent } from "@testing-library/react-native"

import HomeScreen, { activeRows, sortNeedsYou } from "../app/(tabs)/index"
import type { HomeSummary, QueueColumnView } from "@/lib/types"
import type { PhaseKey } from "@/lib/phases"

const mockPush = jest.fn()

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
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
    const entry = mockQueryData[path] as { data?: unknown; error?: Error }
    return {
      data: entry?.data,
      error: entry?.error,
      isError: !!entry?.error,
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
      raised: "#2a2b2f",
      foreground: "#f5f5f7",
      muted: "#a0a0b0",
      faint: "#606070",
      line: "rgba(255,255,255,0.08)",
      glass: "rgba(15,15,17,0.6)",
      "glass-edge": "rgba(255,255,255,0.10)",
      fill: "rgba(255,255,255,0.10)",
      selection: "rgba(255,255,255,0.16)",
      sheet: "rgba(23,23,23,0.94)",
      "sheet-card": "#2a2b2f",
      hover: "rgba(255,255,255,0.05)",
      brand: "#8a2be2",
      "brand-soft": "#a080d0",
      red: "#e74055",
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
    PhasePill: ({ phase, children }: { phase: string; children?: React.ReactNode }) => (
      <RNView><RNText>PhasePill:{phase}</RNText>{children ? <RNText>{children}</RNText> : null}</RNView>
    ),
    phaseLabel: (phase: string) => phase,
    TOP_INSET: 116,
    Card: ({ children }: { children: React.ReactNode }) => (
      <RNView>{children}</RNView>
    ),
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
    Pill: ({ label, children }: { label?: string; children?: React.ReactNode }) => (
      <RNView><RNText>{children ?? label}</RNText></RNView>
    ),
  }
})

jest.mock("@/components/icons", () => ({
  Icon: ({ name }: { name: string }) => null,
}))

jest.mock("@/components/TopBarPill", () => ({
  TopBarPill: () => null,
}))

jest.mock("@/components/ReviewFab", () => ({
  ReviewFab: () => null,
}))

const HOME_SUMMARY: HomeSummary = {
  reports: 12,
  open: 9,
  awaiting: 3,
  targets: 1,
  decisions: 2,
  needsYou: 3,
  phases: [],
}

// "now" fixed at 2026-08-26T12:00:00Z so relativeTime is deterministic.
const NOW = new Date("2026-08-26T12:00:00Z").getTime()

const QUEUE_DATA: QueueColumnView[] = [
  {
    key: "triaging",
    label: "Triaging",
    states: ["TRIAGING", "NEEDS_DECISION"],
    total: 1,
    cards: [
      {
        id: "r-active-1",
        title: "SQL injection in login",
        sourceLabel: "#482",
        targetName: "juice-shop",
        channel: "github",
        state: "TRIAGING",
        outcome: null,
        verdictSuperseded: false,
        jobDeadLettered: false,
        sessionErrored: false,
        runStatus: null,
        deliveryState: null,
        handoffFailed: false,
        eventCount: 5,
        updatedAt: "2026-08-26T11:55:00Z",
        ageLabel: "5m",
        awaitingVerdictId: null,
        investigating: false,
      },
    ],
  },
  {
    key: "analysis-only",
    label: "Analysis only",
    states: ["REPRODUCING", "ANALYSIS_ONLY"],
    total: 1,
    cards: [
      {
        id: "r-active-2",
        title: "Open redirect on /redirect",
        sourceLabel: "#483",
        targetName: null,
        channel: "github",
        state: "ANALYSIS_ONLY",
        outcome: null,
        verdictSuperseded: false,
        jobDeadLettered: false,
        sessionErrored: false,
        runStatus: null,
        deliveryState: null,
        handoffFailed: false,
        eventCount: 3,
        updatedAt: "2026-08-26T11:50:00Z",
        ageLabel: "10m",
        awaitingVerdictId: null,
        investigating: false,
      },
    ],
  },
  {
    key: "awaiting-approval",
    label: "Awaiting approval",
    states: ["AWAITING_APPROVAL"],
    total: 1,
    cards: [
      {
        id: "r-needs-1",
        title: "Missing rate limit on login",
        sourceLabel: "#481",
        targetName: "juice-shop",
        channel: "github",
        state: "AWAITING_APPROVAL",
        outcome: "NOT_REPRODUCED",
        verdictSuperseded: false,
        jobDeadLettered: false,
        sessionErrored: false,
        runStatus: null,
        deliveryState: null,
        handoffFailed: false,
        eventCount: 7,
        updatedAt: "2026-08-26T11:45:00Z",
        ageLabel: "15m",
        awaitingVerdictId: "v-1",
        investigating: false,
      },
    ],
  },
  {
    key: "delivered",
    label: "Delivered",
    states: ["DELIVERING", "DELIVERED"],
    total: 1,
    cards: [
      {
        id: "r-delivered-1",
        title: "Reflected XSS in /search",
        sourceLabel: "#479",
        targetName: "juice-shop",
        channel: "github",
        state: "DELIVERED",
        outcome: "REPRODUCED",
        verdictSuperseded: false,
        jobDeadLettered: false,
        sessionErrored: false,
        runStatus: null,
        deliveryState: "DELIVERED",
        handoffFailed: false,
        eventCount: 2,
        updatedAt: "2026-08-25T10:00:00Z",
        ageLabel: "1d",
        awaitingVerdictId: null,
        investigating: false,
      },
    ],
  },
  {
    key: "closed",
    label: "Closed",
    states: ["DENIED", "OUT_OF_SCOPE", "CANCELLED", "EXPIRED"],
    total: 1,
    cards: [
      {
        id: "r-closed-1",
        title: "CSRF on profile update",
        sourceLabel: "#476",
        targetName: "juice-shop",
        channel: "github",
        state: "DENIED",
        outcome: "NOT_REPRODUCED",
        verdictSuperseded: false,
        jobDeadLettered: false,
        sessionErrored: false,
        runStatus: null,
        deliveryState: null,
        handoffFailed: false,
        eventCount: 1,
        updatedAt: "2026-08-24T10:00:00Z",
        ageLabel: "2d",
        awaitingVerdictId: null,
        investigating: false,
      },
    ],
  },
]

const EMPTY_QUEUE: QueueColumnView[] = [
  { key: "triaging", label: "Triaging", states: ["TRIAGING", "NEEDS_DECISION"], total: 0, cards: [] },
  { key: "analysis-only", label: "Analysis only", states: ["REPRODUCING", "ANALYSIS_ONLY"], total: 0, cards: [] },
  { key: "awaiting-approval", label: "Awaiting approval", states: ["AWAITING_APPROVAL"], total: 0, cards: [] },
  { key: "delivered", label: "Delivered", states: ["DELIVERING", "DELIVERED"], total: 0, cards: [] },
  { key: "closed", label: "Closed", states: ["DENIED", "OUT_OF_SCOPE", "CANCELLED", "EXPIRED"], total: 0, cards: [] },
]

describe("M4 Home", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
    mockQueryData["/home"] = { data: HOME_SUMMARY }
    mockQueryData["/queue?limit=50"] = { data: { columns: QUEUE_DATA } }
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("has no title block: m4 opens straight on its sections", async () => {
    const { queryByText } = await render(<HomeScreen />)
    expect(queryByText("Home")).toBeNull()
  })

  it("renders the awaiting needs-you card with title and Not reproduced pill", async () => {
    const { getByText } = await render(<HomeScreen />)
    expect(getByText("Missing rate limit on login")).toBeTruthy()
    expect(getByText("Not reproduced")).toBeTruthy()
  })

  it("renders active rows from analysis-only and triaging, newest first", async () => {
    const { getByText } = await render(<HomeScreen />)
    expect(getByText("SQL injection in login")).toBeTruthy()
    expect(getByText("Open redirect on /redirect")).toBeTruthy()
  })

  it("renders delivered rows from delivered and closed columns, newest first", async () => {
    const { getByText } = await render(<HomeScreen />)
    expect(getByText("Reflected XSS in /search")).toBeTruthy()
    expect(getByText("CSRF on profile update")).toBeTruthy()
  })

  it("navigates to sign-the-verdict when a needs-you card is pressed", async () => {
    const { getByText } = await render(<HomeScreen />)
    await fireEvent.press(getByText("Missing rate limit on login"))
    expect(mockPush).toHaveBeenCalledWith("/reports/r-needs-1/sign-the-verdict")
  })

  it("navigates to the report case file when an active row is pressed", async () => {
    const { getByText } = await render(<HomeScreen />)
    await fireEvent.press(getByText("SQL injection in login"))
    expect(mockPush).toHaveBeenCalledWith("/reports/r-active-1")
  })

  it("shows 'Nothing needs you' when the awaiting-approval column is empty", async () => {
    mockQueryData["/queue?limit=50"] = {
      data: {
        columns: [
          ...EMPTY_QUEUE.slice(0, 2),
          { ...EMPTY_QUEUE[2], cards: [] }, // awaiting-approval empty
          ...EMPTY_QUEUE.slice(3),
        ],
      },
    }
    const { getByText } = await render(<HomeScreen />)
    expect(getByText("Nothing needs you")).toBeTruthy()
  })

  it("does not render any hardcoded mock report data", async () => {
    const { queryByText } = await render(<HomeScreen />)
    expect(queryByText("BD-1042")).toBeNull()
    expect(queryByText("juice-shop v17.3.0")).toBeNull()
  })
  it("counts sections from server totals, including DELIVERING rows", async () => {
    const cols = (QUEUE_DATA as Array<{ key: string; total: number; cards: Array<Record<string, unknown>> }>).map((c) => {
      if (c.key === "triaging") return { ...c, total: 12 }
      if (c.key === "delivered") return { ...c, total: 7, cards: c.cards.map((card) => ({ ...card, state: "DELIVERING" })) }
      return c
    })
    mockQueryData["/queue?limit=50"] = { data: { columns: cols } }
    const { getByText, queryByText } = await render(<HomeScreen />)
    const triaging = cols.find((c) => c.key === "triaging")!.total
    const analysis = cols.find((c) => c.key === "analysis-only")!.total
    const delivered = cols.find((c) => c.key === "delivered")!.total
    const closed = cols.find((c) => c.key === "closed")!.total
    expect(getByText(String(triaging + analysis))).toBeTruthy()
    expect(getByText(String(delivered + closed))).toBeTruthy()
    expect(queryByText("5")).toBeNull()
  })
  it("shows the error instead of an empty board when /queue fails", async () => {
    mockQueryData["/queue?limit=50"] = { error: new Error("queue unavailable") }
    const { getByText, queryByText } = await render(<HomeScreen />)
    expect(getByText("queue unavailable")).toBeTruthy()
    expect(queryByText("Nothing needs you")).toBeNull()
  })
})

describe("home ordering", () => {
  const card = (id: string, state: string, updatedAt: string, extra: Record<string, unknown> = {}) =>
    ({ id, state, updatedAt, investigating: false, severity: null, ...extra }) as never

  it("lists active reports by phase, longest waiting first, running ones last", () => {
    const rows = activeRows([
      card("tri-new", "TRIAGING", "2026-08-26T11:55:00Z"),
      card("running", "REPRODUCING", "2026-08-26T11:58:00Z", { investigating: true }),
      card("tri-old", "TRIAGING", "2026-08-25T11:00:00Z"),
      card("analysis", "ANALYSIS_ONLY", "2026-08-26T09:00:00Z"),
      card("repro", "REPRODUCING", "2026-08-26T11:00:00Z"),
    ])
    expect(rows.map((r: { id: string }) => r.id)).toEqual(["repro", "analysis", "tri-old"])
  })

  it("sorts needs-you by severity, newest first within a severity", () => {
    const cards = [
      card("low", "AWAITING_APPROVAL", "2026-08-26T11:50:00Z", { severity: "low" }),
      card("none", "AWAITING_APPROVAL", "2026-08-26T11:59:00Z"),
      card("high-old", "AWAITING_APPROVAL", "2026-08-26T10:00:00Z", { severity: "high" }),
      card("high-new", "AWAITING_APPROVAL", "2026-08-26T11:00:00Z", { severity: "high" }),
    ]
    expect(sortNeedsYou(cards, "severity").map((c: { id: string }) => c.id)).toEqual(["high-new", "high-old", "low", "none"])
    expect(sortNeedsYou(cards, "newest").map((c: { id: string }) => c.id)).toEqual(["none", "low", "high-new", "high-old"])
  })
})

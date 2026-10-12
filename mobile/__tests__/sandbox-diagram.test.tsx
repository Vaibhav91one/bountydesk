/**
 * M26 Sandbox diagram render tests: loading, data, and empty states.
 */
import React from "react"
import { render } from "@testing-library/react-native"

import SandboxDiagramScreen from "../app/reports/[id]/sandbox-diagram"
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
      line: "rgba(255,255,255,0.08)",
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
    KvRow: ({ label, value }: { label: string; value: string }) => (
      <RNView><RNText>{label}</RNText><RNText>{value}</RNText></RNView>
    ),
    EmptyState: ({ heading, body }: { heading: string; body?: string }) => (
      <RNView><RNText>{heading}</RNText>{body ? <RNText>{body}</RNText> : null}</RNView>
    ),
  }
})

jest.mock("@/components/icons", () => {
  const { Text: RNText } = require("react-native")
  return {
    Icon: ({ name }: { name: string }) => <RNText>{name}</RNText>,
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
  target: { id: "tgt-1", name: "juice-shop", imageDigest: "sha256:abc123def456789" },
  summary: "Stored XSS",
  destination: "",
  verdict: null,
  awaitingVerdictId: null,
  approval: null,
  delivery: null,
  events: [],
  toolCalls: [],
  appeals: [],
}

describe("M26 Sandbox diagram", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders the screen title in loading state", async () => {
    mockQueryData["/reports/report-1"] = {}
    const { getByText, getAllByText } = await render(<SandboxDiagramScreen />)
    expect(getAllByText("Reproduction sandbox").length).toBeGreaterThanOrEqual(1)
    expect(getByText("Back")).toBeTruthy()
  })

  it("renders all four sandbox nodes", async () => {
    mockQueryData["/reports/report-1"] = { data: SAMPLE_REPORT }
    const { getByText, getAllByText } = await render(<SandboxDiagramScreen />)
    expect(getByText(/github · Stored XSS in search results/)).toBeTruthy()
    expect(getByText("Build sandbox")).toBeTruthy()
    expect(getAllByText("Reproduction sandbox").length).toBeGreaterThanOrEqual(1)
    expect(getByText("Canary oracle")).toBeTruthy()
    expect(getByText("Human gate")).toBeTruthy()
  })

  it("renders the notes section with target and oracle information", async () => {
    mockQueryData["/reports/report-1"] = { data: SAMPLE_REPORT }
    const { getByText, getAllByText } = await render(<SandboxDiagramScreen />)
    expect(getByText("Notes")).toBeTruthy()
    expect(getByText("juice-shop")).toBeTruthy()
    expect(getAllByText("Outside the sandbox").length).toBeGreaterThanOrEqual(1)
    expect(getByText(/oracle runs outside the sandbox/)).toBeTruthy()
  })
})

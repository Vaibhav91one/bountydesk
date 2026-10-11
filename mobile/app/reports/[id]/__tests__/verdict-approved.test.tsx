/**
 * Tests for M12 Verdict approved: loading state, data state showing the receipt
 * card with outcome, channel, receipt, delivered time, and content hash.
 */
import React from "react"
import { render } from "@testing-library/react-native"

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({ id: "BD-1042" }),
}))

jest.mock("expo-haptics", () => ({
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}))

jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn().mockResolvedValue(false),
  isEnrolledAsync: jest.fn().mockResolvedValue(false),
  authenticateAsync: jest.fn().mockResolvedValue({ success: true }),
}))

const mockUseApiQuery = jest.fn()
jest.mock("@/lib/use-query", () => ({
  useApiQuery: (...args: unknown[]) => mockUseApiQuery(...args),
  ApiError: class ApiError extends Error {
    status: number
    code?: string
    constructor(status: number, code?: string, message?: string) {
      super(message ?? `API error: ${status}`)
      this.name = "ApiError"
      this.status = status
      if (code) this.code = code
    }
  },
}))

jest.mock("@/components/SvgImage", () => ({
  SvgImage: ({ name }: { name: string }) => {
    const React = require("react")
    return React.createElement("SvgImage", { testID: `svg-${name}` })
  },
}))

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({
    getToken: jest.fn().mockResolvedValue("token"),
    isLoaded: true,
    isSignedIn: true,
  }),
}))

// The screens call useToast() at the top of the function body, but wrap their
// output in <ToastProvider>. In tests we render the component directly, so we
// mock useToast to return a stub and pass through the real primitives.
jest.mock("@/components/primitives", () => {
  const actual = jest.requireActual("@/components/primitives")
  return {
    ...actual,
    useToast: () => ({ show: jest.fn() }),
  }
})

const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => <>{children}</>

const sampleCaseFile = {
  id: "BD-1042",
  title: "Stored XSS in search results",
  issueNumber: 1042,
  sourceLabel: "GitHub",
  channel: "github",
  deliveryChannel: "github",
  repositoryFullName: "Vaibhav91one/juice-shop",
  reporterHandle: "user123",
  createdAt: "2025-01-15T10:00:00Z",
  updatedAt: "2025-01-15T11:00:00Z",
  state: "DELIVERED",
  stateLabel: "Delivered",
  phase: "delivered",
  investigating: false,
  failed: false,
  target: { id: "t1", name: "juice-shop", imageDigest: "sha256:abc" },
  summary: "Stored XSS in search results",
  destination: "github:123:issue:456",
  verdict: {
    id: "v-1",
    revision: 1,
    outcome: "REPRODUCED",
    outcomeLabel: "Reproduced",
    summary: "Stored XSS reproduced",
    payload: "Thanks for the report.",
    contentHash: "9f2c61ab07d4e8135c0be7a4f6d2189a3b5e04c7d91f8a26e0b34c5d7f1a82e6",
    superseded: false,
    findings: [{ title: "Stored XSS", severity: "high", description: "desc", evidenceRef: "ref" }],
  },
  awaitingVerdictId: null,
  approval: null,
  delivery: {
    state: "DELIVERED",
    deliveredAt: "2025-01-15T09:41:00Z",
    requiresHumanReview: false,
    transportReceipt: "issue comment 2xx",
    target: "github:123:issue:456",
  },
  events: [],
  toolCalls: [],
  appeals: [],
}

const VerdictApproved = require("../verdict-approved").default
const ApiError = require("@/lib/use-query").ApiError

describe("M12 Verdict approved", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders loading state when data is not yet available", async () => {
    mockUseApiQuery.mockReturnValue({
      data: undefined,
      error: undefined,
      isError: false,
    })

    const { queryByText } = await render(<TestWrapper><VerdictApproved /></TestWrapper>)
    expect(queryByText("Loading")).toBeTruthy()
  })

  it("renders mascot, delivered title, report meta, receipt card and hash", async () => {
    mockUseApiQuery.mockReturnValue({
      data: sampleCaseFile,
      error: undefined,
      isError: false,
    })

    const { queryByText, getByText, getAllByText } = await render(<TestWrapper><VerdictApproved /></TestWrapper>)

    // Mascot + title
    expect(queryByText("Verdict delivered")).toBeTruthy()
    // Report meta
    expect(getAllByText("BD-1042 · Stored XSS in search results").length).toBeGreaterThanOrEqual(1)
    // Receipt card rows
    expect(getByText("Reproduced")).toBeTruthy() // outcome pill
    expect(getAllByText("issue comment 2xx").length).toBeGreaterThanOrEqual(1) // receipt
    // Content hash
    expect(getByText("sha256:9f2c61ab07d4e8135c0be7a4f6d2189a3b5e04c7d91f8a26e0b34c5d7f1a82e6")).toBeTruthy()
    // Back to queue button
    expect(getByText("Back to queue")).toBeTruthy()
    // Note
    expect(getByText(/Marked delivered only after GitHub confirmed/)).toBeTruthy()
  })

  it("shows error state for non-auth errors", async () => {
    mockUseApiQuery.mockReturnValue({
      data: undefined,
      error: new ApiError(500, undefined, "Server error"),
      isError: true,
    })

    const { getByText } = await render(<TestWrapper><VerdictApproved /></TestWrapper>)
    expect(getByText(/Server error/)).toBeTruthy()
  })
})

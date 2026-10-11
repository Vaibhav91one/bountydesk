/**
 * Tests for M11 Sign the verdict: loading state, data state (hash matches
 * payload), the 409 content_hash_mismatch refresh state that does not auto-
 * retry, and the invariant that the exact contentHash from the API is sent
 * on approve.
 */
import React from "react"
import { render, fireEvent, waitFor } from "@testing-library/react-native"

// Mock expo-router. useRouter is mocked per-test for some assertions.
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), popToTop: jest.fn() }
jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: "BD-1042" }),
}))

jest.mock("expo-haptics", () => ({
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}))

// Biometric auth is mocked: no hardware on the test runtime.
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn().mockResolvedValue(false),
  isEnrolledAsync: jest.fn().mockResolvedValue(false),
  authenticateAsync: jest.fn().mockResolvedValue({ success: true }),
}))

const mockApi = jest.fn()
const mockUseApiQuery = jest.fn()
jest.mock("@/lib/use-query", () => ({
  useApiQuery: (...args: unknown[]) => mockUseApiQuery(...args),
  useApiMutation: jest.fn(() => ({ mutate: jest.fn() })),
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

jest.mock("@/lib/api", () => ({
  api: (...args: unknown[]) => mockApi(...args),
  setTokenGetter: jest.fn(),
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

// SvgImage loads a webpack/expo asset; mock it as a plain element.
jest.mock("@/components/SvgImage", () => ({
  SvgImage: ({ name }: { name: string }) => {
    const React = require("react")
    return React.createElement("SvgImage", { testID: `svg-${name}` })
  },
}))

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({
    getToken: jest.fn().mockResolvedValue("test-token"),
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
  state: "AWAITING_APPROVAL",
  stateLabel: "Awaiting approval",
  phase: "approval",
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
    summary: "Stored XSS reproduced in sandbox",
    payload: "Thanks for the report. We reproduced this on juice-shop v17.3.0 (1867b92). The q parameter on the search page is stored and rendered without output encoding, and our canary payload executed in the sandbox. Severity: high. Suggested fix: encode on render and drop bypassSecurityTrustHtml for user input.",
    contentHash: "9f2c61ab07d4e8135c0be7a4f6d2189a3b5e04c7d91f8a26e0b34c5d7f1a82e6",
    superseded: false,
    findings: [{ title: "Stored XSS", severity: "high", description: "q param not encoded", evidenceRef: "body:1" }],
  },
  awaitingVerdictId: "v-1",
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

// Require the component after all mocks are in place.
const SignTheVerdict = require("../sign-the-verdict").default
const ApiError = require("@/lib/api").ApiError

describe("M11 Sign the verdict", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders loading state when data is not yet available", async () => {
    mockUseApiQuery.mockReturnValue({
      data: undefined,
      error: undefined,
      isError: false,
      refetch: jest.fn(),
    })

    const { queryByText } = await render(<TestWrapper><SignTheVerdict /></TestWrapper>)
    expect(queryByText("Loading")).toBeTruthy()
  })

  it("renders the drafted comment, outcome, severity, delivery and correct content hash", async () => {
    mockUseApiQuery.mockReturnValue({
      data: sampleCaseFile,
      error: undefined,
      isError: false,
      refetch: jest.fn(),
    })

    const { getByText, queryByText } = await render(<TestWrapper><SignTheVerdict /></TestWrapper>)

    // Outcome pill
    expect(getByText("Reproduced")).toBeTruthy()
    // Severity (capitalized)
    expect(getByText("High")).toBeTruthy()
    // Delivery
    expect(getByText("Comment on GitHub issue")).toBeTruthy()
    // Drafted comment text
    expect(getByText(/Thanks for the report/)).toBeTruthy()
    // Content hash displayed with sha256: prefix
    expect(getByText("sha256:9f2c61ab07d4e8135c0be7a4f6d2189a3b5e04c7d91f8a26e0b34c5d7f1a82e6")).toBeTruthy()
    // Report meta line
    expect(queryByText("BD-1042 · Stored XSS in search results")).toBeTruthy()
    // Note text
    expect(getByText(/This exact text is what gets sent/)).toBeTruthy()
    expect(getByText(/Approval is bound to this hash/)).toBeTruthy()
    // Deny and Approve buttons
    expect(getByText("Deny")).toBeTruthy()
    expect(getByText("Approve")).toBeTruthy()
  })

  it("shows the refresh state on 409 content_hash_mismatch after approve", async () => {
    const mockRefetch = jest.fn()
    mockUseApiQuery.mockReturnValue({
      data: sampleCaseFile,
      error: undefined,
      isError: false,
      refetch: mockRefetch,
    })

    // The approve POST calls api() which rejects with a 409 content_hash_mismatch.
    mockApi.mockRejectedValueOnce(new ApiError(409, "content_hash_mismatch", "mismatch"))

    const { getByText, queryByText } = await render(<TestWrapper><SignTheVerdict /></TestWrapper>)

    const approveBtn = getByText("Approve")
    await fireEvent.press(approveBtn)

    // Wait for the async approve handler to process the 409 and show the mismatch state.
    await waitFor(() => {
      expect(mockRefetch).toHaveBeenCalled()
    }, { timeout: 2000 })

    await waitFor(() => {
      expect(queryByText("This verdict changed")).toBeTruthy()
    }, { timeout: 2000 })
    expect(queryByText(/Refresh and review/)).toBeTruthy()
    expect(queryByText(/This verdict changed/)).toBeTruthy()
  })

  it("does not auto-retry on 409 and waits for manual refresh", async () => {
    const mockRefetch = jest.fn()
    mockUseApiQuery.mockReturnValue({
      data: sampleCaseFile,
      error: undefined,
      isError: false,
      refetch: mockRefetch,
    })

    mockApi.mockRejectedValueOnce(new ApiError(409, "content_hash_mismatch", "mismatch"))

    const { getByText } = await render(<TestWrapper><SignTheVerdict /></TestWrapper>)

    await fireEvent.press(getByText("Approve"))
    await new Promise((r) => setTimeout(r, 500))

    // Only one refetch call (from the 409 handler), no automatic retries.
    expect(mockRefetch).toHaveBeenCalledTimes(1)
  })

  it("sends the exact contentHash returned by the API, not a recomputed one", async () => {
    mockUseApiQuery.mockReturnValue({
      data: sampleCaseFile,
      error: undefined,
      isError: false,
      refetch: jest.fn(),
    })

    mockApi.mockResolvedValueOnce({ ok: true })

    const { getByText } = await render(<TestWrapper><SignTheVerdict /></TestWrapper>)

    await fireEvent.press(getByText("Approve"))
    await new Promise((r) => setTimeout(r, 500))

    const lastCall = mockApi.mock.calls[mockApi.mock.calls.length - 1]
    const body = JSON.parse(lastCall[1].body)
    expect(body.contentHash).toBe("9f2c61ab07d4e8135c0be7a4f6d2189a3b5e04c7d91f8a26e0b34c5d7f1a82e6")
    expect(body.verdictId).toBe("v-1")
  })

  it("shows error state for non-auth errors", async () => {
    mockUseApiQuery.mockReturnValue({
      data: undefined,
      error: new ApiError(500, undefined, "Server error"),
      isError: true,
      refetch: jest.fn(),
    })

    const { getByText } = await render(<TestWrapper><SignTheVerdict /></TestWrapper>)
    expect(getByText(/Server error/)).toBeTruthy()
  })
})

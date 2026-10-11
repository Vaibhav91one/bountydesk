/**
 * Tests for M13 Deny verdict: loading state, data state showing the deny sheet
 * with reasons, and the invariant that the exact contentHash from the API is
 * sent with the deny POST. Does not auto-retry on 409.
 */
import React from "react"
import { render, fireEvent } from "@testing-library/react-native"

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), popToTop: jest.fn() }
jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
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

const mockApi = jest.fn()
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

const DenyVerdict = require("../deny-verdict").default
const ApiError = require("@/lib/api").ApiError

describe("M13 Deny verdict", () => {
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

    const { queryByText } = await render(<TestWrapper><DenyVerdict /></TestWrapper>)
    expect(queryByText("Loading")).toBeTruthy()
  })

  it("renders the sign-the-verdict content with the deny sheet open by default", async () => {
    mockUseApiQuery.mockReturnValue({
      data: sampleCaseFile,
      error: undefined,
      isError: false,
      refetch: jest.fn(),
    })

    const { queryByText, getByText, getAllByText, getByLabelText } = await render(<TestWrapper><DenyVerdict /></TestWrapper>)

    // The M13 content mirrors M11
    expect(queryByText("Sign the verdict")).toBeTruthy()
    expect(getAllByText("BD-1042 · Stored XSS in search results").length).toBeGreaterThanOrEqual(1)
    expect(getByText("Reproduced")).toBeTruthy()
    expect(getByText("High")).toBeTruthy()
    expect(getByText("Comment on GitHub issue")).toBeTruthy()
    expect(getByText(/Thanks for the report/)).toBeTruthy()
    expect(getByText("sha256:9f2c61ab07d4e8135c0be7a4f6d2189a3b5e04c7d91f8a26e0b34c5d7f1a82e6")).toBeTruthy()
    // Deny sheet content (sheet is open by default in M13)
    expect(queryByText("Out of scope")).toBeTruthy()
    expect(queryByText("The target is not covered by the program")).toBeTruthy()
    expect(queryByText("Not reproduced")).toBeTruthy()
    expect(queryByText("Duplicate")).toBeTruthy()
    expect(queryByText("Insufficient detail")).toBeTruthy()
    expect(queryByText("Note to reporter (optional)")).toBeTruthy()
    // The note text inside the sheet (Modal children may not be queryable)
  })

  it("sends the exact contentHash received from the API with the deny POST", async () => {
    mockUseApiQuery.mockReturnValue({
      data: sampleCaseFile,
      error: undefined,
      isError: false,
      refetch: jest.fn(),
    })

    mockApi.mockResolvedValueOnce({ ok: true })

    const { getByLabelText } = await render(<TestWrapper><DenyVerdict /></TestWrapper>)

    await fireEvent.press(getByLabelText("Confirm"))
    await new Promise((r) => setTimeout(r, 500))

    const lastCall = mockApi.mock.calls[mockApi.mock.calls.length - 1]
    const body = JSON.parse(lastCall[1].body)
    expect(body.contentHash).toBe("9f2c61ab07d4e8135c0be7a4f6d2189a3b5e04c7d91f8a26e0b34c5d7f1a82e6")
    expect(body.verdictId).toBe("v-1")
    expect(body.reason).toBe("Out of scope")
  })

  it("does not auto-retry on 409 content_hash_mismatch and shows the refresh state", async () => {
    const mockRefetch = jest.fn()
    mockUseApiQuery.mockReturnValue({
      data: sampleCaseFile,
      error: undefined,
      isError: false,
      refetch: mockRefetch,
    })

    mockApi.mockRejectedValueOnce(new ApiError(409, "content_hash_mismatch", "mismatch"))

    const { queryByText, getByLabelText } = await render(<TestWrapper><DenyVerdict /></TestWrapper>)

    await fireEvent.press(getByLabelText("Confirm"))
    await new Promise((r) => setTimeout(r, 500))

    expect(mockRefetch).toHaveBeenCalledTimes(1)
    expect(queryByText("This verdict changed")).toBeTruthy()
  })
})

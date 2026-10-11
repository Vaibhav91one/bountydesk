import { render, fireEvent, waitFor } from "@testing-library/react-native"
import * as LocalAuthentication from "expo-local-authentication"
import * as Haptics from "expo-haptics"

const sampleCaseFile = {
  id: "BD-1042",
  title: "Stored XSS in search results",
  channel: "github",
  verdict: {
    id: "v_abc123",
    outcome: "REPRODUCED",
    outcomeLabel: "Reproduced",
    payload: "Found a stored XSS in the search results page.",
    contentHash: "9f2c61ab07d4e8135c0be7a4f6d2189a3b5e04c7d91f8a26e0b34c5d7f1a82e6",
    findings: [{ severity: "high" }],
  },
  delivery: {
    state: "pending",
    deliveredAt: null,
    requiresHumanReview: true,
    target: "github:org/repo:issue:42",
    transportReceipt: null,
  },
}

const mockRefetch = jest.fn()
const mockApiQuery = jest.fn()
const mockApi = jest.fn()

class mockApiError extends Error {
  constructor(public readonly status: number, public readonly code?: string, message?: string) {
    super(message)
    this.name = "ApiError"
  }
}
const ApiError = mockApiError

jest.mock("@/lib/use-query", () => ({
  useApiQuery: mockApiQuery,
  ApiError: mockApiError,
}))

jest.mock("@/lib/api", () => ({
  api: mockApi,
}))

jest.mock("expo-router", () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    popToTop: jest.fn(),
  }),
  useLocalSearchParams: () => ({ id: "BD-1042" }),
}))

jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(),
  isEnrolledAsync: jest.fn(),
  authenticateAsync: jest.fn(),
}))

jest.mock("expo-haptics", () => ({
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: "success", Warning: "warning" },
}))

// Keep real ToastProvider; stub useToast (same pattern as M11).
jest.mock("@/components/primitives", () => {
  const actual = jest.requireActual("@/components/primitives")
  return {
    ...actual,
    useToast: () => ({ show: jest.fn() }),
  }
})

const DenyVerdict = require("../deny-verdict").default

function setMockData(data: typeof sampleCaseFile | null, opts: { isError?: boolean; error?: any } = {}) {
  mockApiQuery.mockReturnValue({
    data: data,
    error: opts.error ?? undefined,
    isError: opts.isError ?? false,
    refetch: mockRefetch,
  })
}

describe("M13 Deny verdict", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRefetch.mockResolvedValue({ data: sampleCaseFile })
    ;(LocalAuthentication.hasHardwareAsync as jest.Mock).mockResolvedValue(false)
    ;(LocalAuthentication.isEnrolledAsync as jest.Mock).mockResolvedValue(false)
  })

  it("renders loading state when data is not yet available", async () => {
    setMockData(null)
    const { queryByText } = await render(<DenyVerdict />)
    expect(queryByText("Loading")).toBeTruthy()
  })

  it("has no Approve button (M13 is deny-only)", async () => {
    setMockData(sampleCaseFile)
    const { queryByText } = await render(<DenyVerdict />)
    expect(queryByText("Approve")).toBeFalsy()
  })

  it("renders the sign-the-verdict content with the deny sheet open by default", async () => {
    setMockData(sampleCaseFile)
    const { queryByText, getAllByText } = await render(<DenyVerdict />)

    // The M13 content mirrors M11
    expect(queryByText("Sign the verdict")).toBeTruthy()
    expect(getAllByText("BD-1042 · Stored XSS in search results").length).toBeGreaterThanOrEqual(1)
    expect(queryByText("Reproduced")).toBeTruthy()
    expect(queryByText("High")).toBeTruthy()
    expect(queryByText("Comment on GitHub issue")).toBeTruthy()
    expect(queryByText(/Found a stored XSS/)).toBeTruthy()
    expect(queryByText("sha256:9f2c61ab07d4e8135c0be7a4f6d2189a3b5e04c7d91f8a26e0b34c5d7f1a82e6")).toBeTruthy()

    // Deny sheet content (sheet is open by default in M13)
    expect(queryByText("Out of scope")).toBeTruthy()
    expect(queryByText("The target is not covered by the program")).toBeTruthy()
    expect(queryByText("Not reproduced")).toBeTruthy()
    expect(queryByText("The agent could not trigger the behavior")).toBeTruthy()
    expect(queryByText("Duplicate")).toBeTruthy()
    expect(queryByText("Insufficient detail")).toBeTruthy()
    expect(queryByText("Note to reporter (optional)")).toBeTruthy()
  })

  it("sends the exact contentHash received from the API with the deny POST", async () => {
    setMockData(sampleCaseFile)
    mockApi.mockResolvedValueOnce({ ok: true })

    const { getByLabelText } = await render(<DenyVerdict />)

    await fireEvent.press(getByLabelText("Confirm"))
    await new Promise((r) => setTimeout(r, 500))

    const denyCall = mockApi.mock.calls.find((c: any) => c[0].includes("/deny"))
    expect(denyCall).toBeTruthy()
    const body = JSON.parse(denyCall[1].body)
    expect(body.verdictId).toBe(sampleCaseFile.verdict.id)
    expect(body.contentHash).toBe(sampleCaseFile.verdict.contentHash)
  })

  it("does not auto-retry on 409 content_hash_mismatch and shows the refresh state", async () => {
    setMockData(sampleCaseFile)
    mockApi.mockRejectedValueOnce(new ApiError(409, "content_hash_mismatch", "mismatch"))

    const { getByLabelText } = await render(<DenyVerdict />)

    await fireEvent.press(getByLabelText("Confirm"))
    await new Promise((r) => setTimeout(r, 500))

    // refetch is called once (stale check inside handleDenyConfirm), but the
    // 409 handler does NOT trigger an automatic retry.
    expect(mockRefetch).toHaveBeenCalledTimes(1)
  })
})

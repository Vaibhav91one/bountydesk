import { render, fireEvent, waitFor } from "@testing-library/react-native"
import * as LocalAuthentication from "expo-local-authentication"
import * as Haptics from "expo-haptics"

// --- Mock data (STEP 10: no mocking of ToastProvider or useToast) ---
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

// --- Mock hooks (preserve ToastProvider behavior) ---
const mockRefetch = jest.fn()
const mockApiQuery = jest.fn()
const mockApi = jest.fn()

// Define ApiError locally — the real use-query.ts pulls in @clerk/expo via
// use-api-error.ts which breaks in the Jest environment. The screen only needs
// instanceof ApiError and .status/.code, so a structural local class suffices.
// Named with 'mock' prefix so jest.mock factory can reference it.
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
    dismissAll: jest.fn(),
    canDismiss: jest.fn(() => true),
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

// Use the real ToastProvider and useToast — do not stub them. The screens render
// inside <ToastProvider> at the default-export boundary, so toasts are real.
jest.mock("@/components/primitives", () => jest.requireActual("@/components/primitives"))

// --- Static require for the screen component (no dynamic import) ---
const SignTheVerdict = require("../sign-the-verdict").default

function setMockData(data: typeof sampleCaseFile | null, opts: { isError?: boolean; error?: any } = {}) {
  mockApiQuery.mockReturnValue({
    data: data,
    error: opts.error ?? undefined,
    isError: opts.isError ?? false,
    status: opts.isError ? "error" : "success",
    refetch: mockRefetch,
  })
}

describe("M11 Sign the verdict", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.clearAllTimers()
    mockRefetch.mockResolvedValue({ data: sampleCaseFile, isError: false, status: "success" })
    ;(LocalAuthentication.hasHardwareAsync as jest.Mock).mockResolvedValue(false)
    ;(LocalAuthentication.isEnrolledAsync as jest.Mock).mockResolvedValue(false)
    ;(LocalAuthentication.authenticateAsync as jest.Mock).mockResolvedValue({ success: true })
  })

  it("renders loading state when data is not yet available", async () => {
    setMockData(null)
    const { queryByText } = await render(<SignTheVerdict />)
    expect(queryByText("Loading")).toBeTruthy()
  })

  it("renders the drafted comment, outcome, severity, delivery and correct content hash", async () => {
    setMockData(sampleCaseFile)
    const { queryByText, getByText } = await render(<SignTheVerdict />)

    expect(queryByText("Sign the verdict")).toBeTruthy()
    expect(getByText("Reproduced")).toBeTruthy() // outcome pill
    expect(getByText("High")).toBeTruthy() // severity
    expect(queryByText("Comment on GitHub issue")).toBeTruthy() // delivery
    expect(getByText(/Found a stored XSS/)).toBeTruthy() // payload
    expect(getByText("sha256:9f2c61ab07d4e8135c0be7a4f6d2189a3b5e04c7d91f8a26e0b34c5d7f1a82e6")).toBeTruthy()
  })

  it("shows the refresh state on 409 content_hash_mismatch after approve", async () => {
    setMockData(sampleCaseFile)
    mockApi.mockRejectedValueOnce(new ApiError(409, "content_hash_mismatch", "mismatch"))

    const { getByText, queryByText } = await render(<SignTheVerdict />)

    await fireEvent.press(getByText("Approve"))

    // The 409 is caught and sets hashMismatch → shows the refresh box.
    await waitFor(() => {
      expect(queryByText(/This verdict changed/)).toBeTruthy()
      expect(queryByText(/Refresh and review/)).toBeTruthy()
    })
  })

  it("does not auto-retry on 409 and waits for manual refresh", async () => {
    setMockData(sampleCaseFile)
    mockApi.mockRejectedValueOnce(new ApiError(409, "content_hash_mismatch", "mismatch"))

    const { getByText } = await render(<SignTheVerdict />)

    await fireEvent.press(getByText("Approve"))
    await new Promise((r) => setTimeout(r, 500))

    // refetch is called once (for the stale check inside handleApprove), but the
    // 409 handler does NOT trigger an automatic retry.
    expect(mockRefetch).toHaveBeenCalledTimes(1)
  })

  it("sends the exact contentHash returned by the API, not a recomputed one", async () => {
    setMockData(sampleCaseFile)
    mockApi.mockResolvedValueOnce({ ok: true })

    const { getByText } = await render(<SignTheVerdict />)

    await fireEvent.press(getByText("Approve"))
    await new Promise((r) => setTimeout(r, 500))

    const approveCall = mockApi.mock.calls.find((c: any) => c[0].includes("/approve"))
    expect(approveCall).toBeTruthy()
    const body = JSON.parse(approveCall[1].body)
    expect(body.verdictId).toBe(sampleCaseFile.verdict.id)
    expect(body.contentHash).toBe(sampleCaseFile.verdict.contentHash)
  })

  it("shows error state for non-auth errors", async () => {
    setMockData(null, { isError: true, error: new ApiError(500, "internal_error", "Server crashed") })

    const { getByText } = await render(<SignTheVerdict />)
    expect(getByText("Server crashed")).toBeTruthy()
  })

  it("does not submit approve when refetch changes the contentHash during the biometric prompt", async () => {
    const changedCaseFile = {
      ...sampleCaseFile,
      verdict: {
        ...sampleCaseFile.verdict,
        contentHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    }

    // First refetch (inside handleApprove) returns the changed case file.
    mockRefetch.mockResolvedValueOnce({ data: changedCaseFile, isError: false, status: "success" })

    setMockData(sampleCaseFile)
    mockApi.mockResolvedValueOnce({ ok: true })

    const { getByText } = await render(<SignTheVerdict />)

    await fireEvent.press(getByText("Approve"))
    await new Promise((r) => setTimeout(r, 500))

    // The api() should never have been called with /approve.
    const approveCall = mockApi.mock.calls.find((c: any) => c[0] && c[0].toString().includes("/approve"))
    expect(approveCall).toBeFalsy()
  })

  it("does not call approve when refetch returns isError:true", async () => {
    setMockData(sampleCaseFile)
    // react-query v5 refetch() resolves (does not throw) with isError:true on network error.
    mockRefetch.mockResolvedValueOnce({ data: null, isError: true, status: "error" })
    mockApi.mockResolvedValue({ ok: true })

    const { getByText } = await render(<SignTheVerdict />)

    await fireEvent.press(getByText("Approve"))
    await new Promise((r) => setTimeout(r, 500))

    // api() should never have been called with /approve.
    const approveCall = mockApi.mock.calls.find((c: any) => c[0] && c[0].toString().includes("/approve"))
    expect(approveCall).toBeFalsy()
  })

  it("re-enables the buttons when the biometric step throws", async () => {
    setMockData(sampleCaseFile)
    // hasHardwareAsync throws — the catch fires, finally re-enables submitting.
    ;(LocalAuthentication.hasHardwareAsync as jest.Mock).mockRejectedValueOnce(new Error("biometric unavailable"))
    mockApi.mockResolvedValue({ ok: true })

    const { getByText, queryByText } = await render(<SignTheVerdict />)

    await fireEvent.press(getByText("Approve"))
    await waitFor(() => {
      expect(queryByText("Approve failed")).toBeTruthy()
    })

    // Buttons should be re-enabled (submitting false again).
    await waitFor(() => {
      expect(queryByText("Approve")).toBeTruthy()
    })
  })

  it("does not submit again after a 2xx response", async () => {
    setMockData(sampleCaseFile)
    mockApi.mockResolvedValue({ ok: true })

    const { getByText } = await render(<SignTheVerdict />)

    await fireEvent.press(getByText("Approve"))
    await new Promise((r) => setTimeout(r, 500))

    // First tap submitted once.
    let approveCalls = mockApi.mock.calls.filter((c: any) => c[0] && c[0].toString().includes("/approve"))
    expect(approveCalls.length).toBe(1)

    // A second tap must NOT submit again — doneRef is true now.
    fireEvent.press(getByText("Approve"))
    await new Promise((r) => setTimeout(r, 500))

    approveCalls = mockApi.mock.calls.filter((c: any) => c[0] && c[0].toString().includes("/approve"))
    expect(approveCalls.length).toBe(1)
  })

  it("double tap on Approve submits only once", async () => {
    setMockData(sampleCaseFile)
    mockApi.mockResolvedValue({ ok: true })

    const { getByText } = await render(<SignTheVerdict />)

    // Fire both presses synchronously. The first starts the async handler and
    // sets submittingRef.current = true before any await; the second press sees
    // the ref and bails out immediately.
    fireEvent.press(getByText("Approve"))
    fireEvent.press(getByText("Approve"))
    await new Promise((r) => setTimeout(r, 1000))

    const approveCalls = mockApi.mock.calls.filter((c: any) => c[0] && c[0].toString().includes("/approve"))
    expect(approveCalls.length).toBe(1)
  })
})

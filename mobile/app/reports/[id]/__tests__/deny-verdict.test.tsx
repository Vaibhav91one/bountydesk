import { render, fireEvent, waitFor } from "@testing-library/react-native"
import * as LocalAuthentication from "expo-local-authentication"
import * as Haptics from "expo-haptics"

const sampleCaseFile = {
  id: "BD-1042",
  sourceLabel: "BD-1042",
  state: "AWAITING_APPROVAL",
  awaitingVerdictId: "v_abc123",
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

const mockParams: { value: Record<string, string> } = { value: { id: "BD-1042", verdictId: "v_abc123", contentHash: "9f2c61ab07d4e8135c0be7a4f6d2189a3b5e04c7d91f8a26e0b34c5d7f1a82e6" } }
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  dismissAll: jest.fn(),
  canDismiss: jest.fn(() => true),
}
jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams.value,
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

// Use the real ToastProvider and useToast — do not stub them.
jest.mock("@/components/primitives", () => jest.requireActual("@/components/primitives"))

const DenyVerdict = require("../deny-verdict").default

function setMockData(data: typeof sampleCaseFile | null, opts: { isError?: boolean; error?: any } = {}) {
  mockApiQuery.mockReturnValue({
    data: data,
    error: opts.error ?? undefined,
    isError: opts.isError ?? false,
    status: opts.isError ? "error" : "success",
    refetch: mockRefetch,
  })
}

const posts = () => mockApi.mock.calls.filter((c: any) => c[0].includes("/deny"))

describe("M13 Deny sheet", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRefetch.mockResolvedValue({ data: sampleCaseFile, isError: false, status: "success" })
    mockApi.mockResolvedValue({ ok: true })
    setMockData(sampleCaseFile)
  })

  it("has Cancel, the title with the report subtitle, Deny, the reasons, the note and the footnote", async () => {
    const { queryByText, queryByLabelText } = await render(<DenyVerdict />)
    expect(queryByLabelText("Cancel")).toBeTruthy()
    expect(queryByText("Deny report")).toBeTruthy()
    expect(queryByText("BD-1042 · Stored XSS in search results")).toBeTruthy()
    expect(queryByLabelText("Submit denial")).toBeTruthy()
    for (const t of ["Out of scope", "Not reproduced", "Duplicate", "Insufficient detail", "Steps or payload are missing", "Note to reporter (optional)"]) {
      expect(queryByText(t)).toBeTruthy()
    }
    expect(queryByText(/Nothing is sent to the reporter until you confirm/)).toBeTruthy()
  })

  it("Cancel dismisses the sheet and sends nothing", async () => {
    const { getByLabelText } = await render(<DenyVerdict />)
    await fireEvent.press(getByLabelText("Cancel"))
    expect(mockRouter.back).toHaveBeenCalled()
    expect(mockRefetch).not.toHaveBeenCalled()
    expect(mockApi).not.toHaveBeenCalled()
  })

  it("keeps Deny disabled until a reason is selected and posts nothing without one", async () => {
    const { getByLabelText } = await render(<DenyVerdict />)
    expect(getByLabelText("Submit denial").props.accessibilityState.disabled).toBe(true)
    await fireEvent.press(getByLabelText("Submit denial"))
    expect(mockApi).not.toHaveBeenCalled()
  })

  it("posts the reason, the optional note and the reviewed id and hash only after Deny", async () => {
    const { getByLabelText, getByText, getByPlaceholderText } = await render(<DenyVerdict />)
    await fireEvent.press(getByText("Duplicate"))
    await fireEvent.changeText(getByPlaceholderText("Sent with the denial"), "  Same as #12  ")
    expect(posts().length).toBe(0)
    await fireEvent.press(getByLabelText("Submit denial"))
    await waitFor(() => expect(posts().length).toBe(1))
    expect(posts()[0][0]).toBe("/reports/BD-1042/deny")
    expect(JSON.parse(posts()[0][1].body)).toEqual({
      verdictId: "v_abc123",
      contentHash: sampleCaseFile.verdict.contentHash,
      reason: "Duplicate: Same as #12",
    })
  })

  it("posts the bare reason when there is no note", async () => {
    const { getByLabelText, getByText } = await render(<DenyVerdict />)
    await fireEvent.press(getByText("Out of scope"))
    await fireEvent.press(getByLabelText("Submit denial"))
    await waitFor(() => expect(posts().length).toBe(1))
    expect(JSON.parse(posts()[0][1].body).reason).toBe("Out of scope")
  })

  it("refuses to deny when the fresh verdict differs from the one M11 showed", async () => {
    mockRefetch.mockResolvedValue({
      data: { ...sampleCaseFile, verdict: { ...sampleCaseFile.verdict, contentHash: "b".repeat(64) } },
      isError: false,
      status: "success",
    })
    const { getByLabelText, getByText, queryByText } = await render(<DenyVerdict />)
    await fireEvent.press(getByText("Duplicate"))
    await fireEvent.press(getByLabelText("Submit denial"))
    await waitFor(() => expect(queryByText("This verdict changed")).toBeTruthy())
    expect(mockApi).not.toHaveBeenCalled()
  })

  it("does not post when the refetch fails", async () => {
    mockRefetch.mockResolvedValue({ data: null, isError: true, status: "error" })
    const { getByLabelText, getByText } = await render(<DenyVerdict />)
    await fireEvent.press(getByText("Duplicate"))
    await fireEvent.press(getByLabelText("Submit denial"))
    await new Promise((r) => setTimeout(r, 100))
    expect(mockApi).not.toHaveBeenCalled()
  })

  it("shows the refresh state on a 409 content_hash_mismatch", async () => {
    mockApi.mockRejectedValueOnce(new ApiError(409, "content_hash_mismatch", "mismatch"))
    const { getByLabelText, getByText, queryByText } = await render(<DenyVerdict />)
    await fireEvent.press(getByText("Duplicate"))
    await fireEvent.press(getByLabelText("Submit denial"))
    await waitFor(() => expect(queryByText("This verdict changed")).toBeTruthy())
  })

  it("cannot deny a report that no longer awaits approval", async () => {
    setMockData({ ...sampleCaseFile, state: "DELIVERED", awaitingVerdictId: null } as any)
    const { getByLabelText, getByText } = await render(<DenyVerdict />)
    await fireEvent.press(getByText("Duplicate"))
    expect(getByLabelText("Submit denial").props.accessibilityState.disabled).toBe(true)
    await fireEvent.press(getByLabelText("Submit denial"))
    expect(mockApi).not.toHaveBeenCalled()
  })

  it("posts once on a double press and then returns to the tabs", async () => {
    const { getByLabelText, getByText } = await render(<DenyVerdict />)
    await fireEvent.press(getByText("Duplicate"))
    fireEvent.press(getByLabelText("Submit denial"))
    fireEvent.press(getByLabelText("Submit denial"))
    await new Promise((r) => setTimeout(r, 1500))
    expect(posts().length).toBe(1)
    expect(mockRouter.dismissAll).toHaveBeenCalled()
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)")
  })
})

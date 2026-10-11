import { render, fireEvent, waitFor } from "@testing-library/react-native"

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
    state: "delivered",
    deliveredAt: "2025-06-01T09:41:00Z",
    requiresHumanReview: false,
    target: "github:org/repo:issue:42",
    transportReceipt: "issue comment 2xx",
  },
}

const mockRefetch = jest.fn()
const mockApiQuery = jest.fn()

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

jest.mock("expo-router", () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
  }),
  useLocalSearchParams: () => ({ id: "BD-1042" }),
}))

// Keep real ToastProvider for M12 (it does not call useToast, but renders ToastProvider).
const VerdictApproved = require("../verdict-approved").default

function setMockData(data: typeof sampleCaseFile | null, opts: { isError?: boolean; error?: any } = {}) {
  mockApiQuery.mockReturnValue({
    data: data,
    error: opts.error ?? undefined,
    isError: opts.isError ?? false,
    status: opts.isError ? "error" : "success",
    refetch: mockRefetch,
  })
}

describe("M12 Verdict approved", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders loading state when data is not yet available", async () => {
    setMockData(null)
    const { queryByText } = await render(<VerdictApproved />)
    expect(queryByText("Loading")).toBeTruthy()
  })

  it("renders mascot, delivered title, report meta, receipt card and hash", async () => {
    setMockData(sampleCaseFile)
    const { queryByText, getByText, getAllByText } = await render(<VerdictApproved />)

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
  })

  it("shows error state for non-auth errors", async () => {

    setMockData(null, { isError: true, error: new ApiError(500, "internal_error", "Server crashed") })

    const { getByText } = await render(<VerdictApproved />)
    expect(getByText("Server crashed")).toBeTruthy()
  })

  it("does not show 'Verdict delivered' when delivery.state is SENT", async () => {
    setMockData({ ...sampleCaseFile, delivery: { ...sampleCaseFile.delivery, state: "SENT" } })
    const { queryByText } = await render(<VerdictApproved />)

    expect(queryByText("Verdict delivered")).toBeFalsy()
    expect(queryByText("Approved. Delivery in progress")).toBeTruthy()
    expect(queryByText("State")).toBeTruthy()
    expect(queryByText("SENT")).toBeTruthy()
  })

  it("shows 'Verdict delivered' only when delivery.state is DELIVERED", async () => {
    setMockData({ ...sampleCaseFile, delivery: { ...sampleCaseFile.delivery, state: "DELIVERED" } })
    const { queryByText, getAllByText } = await render(<VerdictApproved />)

    expect(queryByText("Verdict delivered")).toBeTruthy()
    expect(queryByText("Approved. Delivery in progress")).toBeFalsy()
    expect(getAllByText("issue comment 2xx").length).toBeGreaterThanOrEqual(1) // receipt value shown
  })
})

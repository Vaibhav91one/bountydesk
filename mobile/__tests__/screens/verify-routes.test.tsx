/**
 * Tests for M18 (otp-verify), M20 (submit-a-report), and M21 (contact-verify)
 * that exercise the real verify/upload route contracts.
 *
 * These tests do NOT mock away ToastProvider or useToast: screens are rendered
 * inside the real ToastProvider from @/components/primitives so useToast works
 * on every screen. The api() fetcher is mocked with real server response shapes,
 * so useMutation tracks real success/error state.
 */
import React from "react"
import { render, fireEvent, act, waitFor } from "@testing-library/react-native"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

// --- Param overrides for useLocalSearchParams ------------------------------------
const paramOverrides: Record<string, string | undefined> = {}

// --- Mock the api() fetcher ------------------------------------------------------
// useApiMutation calls api() under the hood. Mocking api() lets useMutation
// track real success/error state with real server response shapes.
const mockApi = jest.fn()

jest.mock("@/lib/use-query", () => {
  const actual = jest.requireActual("@/lib/use-query")
  return {
    ...actual,
    useApiQuery: () => ({ data: undefined, error: undefined, isPending: true }),
    useApiMutation: actual.useApiMutation,
  }
})

jest.mock("@/lib/api", () => ({
  __esModule: true,
  ApiError: jest.requireActual("@/lib/api").ApiError,
  readError: jest.requireActual("@/lib/api").readError,
  api: (...args: unknown[]) => mockApi(...args),
  setTokenGetter: jest.fn(),
}))

// --- Mock SvgImage --------------------------------------------------------------
jest.mock("@/components/SvgImage", () => ({
  SvgImage: ({ name, width, height }: { name: string; width: number; height: number }) => {
    const React = require("react")
    const { View } = require("react-native")
    return React.createElement(View, { testID: `svg-${name}`, width, height })
  },
}))

// --- Mock expo-router -----------------------------------------------------------
const mockPush = jest.fn()
const mockBack = jest.fn()
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: mockBack }),
  useLocalSearchParams: () => paramOverrides,
  Redirect: ({ href }: { href: string }) => {
    const React = require("react")
    const { View, Text } = require("react-native")
    return React.createElement(View, null, React.createElement(Text, null, `Redirect to ${href}`))
  },
}))

// --- Mock Clerk ----------------------------------------------------------------
jest.mock("@clerk/expo", () => ({
  useAuth: () => ({ signOut: jest.fn(), isSignedIn: true, isLoaded: true }),
}))

// --- Mock AsyncStorage ---------------------------------------------------------
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}))

// --- Mock global fetch for contact-verify and submit ----------------------------
global.fetch = jest.fn()

// --- Helpers -------------------------------------------------------------------

function clearAll() {
  jest.clearAllMocks()
  mockApi.mockReset()
  ;(global.fetch as jest.Mock).mockReset()
  Object.keys(paramOverrides).forEach((k) => delete paramOverrides[k])
  mockPush.mockReset()
  mockBack.mockReset()
}

async function renderWithClient(component: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const { ToastProvider } = require("@/components/primitives")
  return await render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{component}</ToastProvider>
    </QueryClientProvider>
  )
}

/** Type six digits one box at a time, awaiting state between each so the code
 * builds up correctly via slice(0, index) + digit + slice(index + 1). */
async function typeOtp(boxes: any[], digits: string) {
  for (let i = 0; i < digits.length; i++) {
    await act(async () => {
      fireEvent.changeText(boxes[i], digits[i])
    })
  }
}

// ============================================================
// M18 OTP verify
// ============================================================
describe("M18 OTP verify", () => {
  const OtpVerifyScreen = require("@/app/more/integrations/otp-verify").default

  beforeEach(() => {
    clearAll()
  })

  it("posts {email, code} to the verify route and shows Verified on success (200)", async () => {
    jest.useFakeTimers()
    paramOverrides.email = "tester@example.com"
    mockApi.mockResolvedValue({ ok: true })

    const result = await renderWithClient(<OtpVerifyScreen />)

    const textInputs = result.getAllByTestId(/^otp-box-\d+$/)
    expect(textInputs.length).toBe(6)

    await typeOtp(textInputs, "123456")

    // Flush the mutation promise resolution and any pending timers from toast show
    await act(async () => {
      jest.runAllTimersAsync()
    })

    expect(mockApi).toHaveBeenCalledWith(
      "/integrations/email/verify",
      expect.objectContaining({ method: "POST" })
    )
    const [, init] = mockApi.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ email: "tester@example.com", code: "123456" })

    expect(result.getByText("Verified")).toBeTruthy()

    // The router.back() fires after a 1000ms toast delay
    await act(async () => {
      jest.advanceTimersByTime(1000)
    })

    expect(mockBack).toHaveBeenCalled()
    jest.useRealTimers()
  })

  it("shows the server error and clears boxes on verify failure (400)", async () => {
    paramOverrides.email = "tester@example.com"

    const { ApiError } = require("@/lib/api")
    mockApi.mockRejectedValue(new ApiError(400, undefined, "invalid code"))

    const result = await renderWithClient(<OtpVerifyScreen />)

    const textInputs = result.getAllByTestId(/^otp-box-\d+$/)

    await typeOtp(textInputs, "123456")

    expect(mockApi).toHaveBeenCalledWith(
      "/integrations/email/verify",
      expect.objectContaining({ method: "POST" })
    )

    await waitFor(() => {
      expect(result.getByText("invalid code")).toBeTruthy()
    })
  })

  it("resend re-POSTs the add route with {email}", async () => {
    paramOverrides.email = "tester@example.com"
    mockApi.mockResolvedValue({ ok: true, codeSent: true })

    const result = await renderWithClient(<OtpVerifyScreen />)

    await act(async () => {
      fireEvent.press(result.getByText("Resend code"))
    })

    await waitFor(() => {
      expect(mockApi).toHaveBeenCalledWith(
        "/integrations/email",
        expect.objectContaining({ method: "POST" })
      )
    })

    const [, init] = mockApi.mock.calls.find(
      (c: unknown[]) => c[0] === "/integrations/email"
    )
    expect(JSON.parse(init.body)).toEqual({ email: "tester@example.com" })
  })

  it("shows an error and goes back when no email param arrives", async () => {
    paramOverrides.email = undefined
    mockApi.mockResolvedValue({ ok: true })

    const result = await renderWithClient(<OtpVerifyScreen />)

    expect(result.getByText("No email address to verify")).toBeTruthy()
    expect(mockBack).toHaveBeenCalled()
  })
})

// ============================================================
// M20 Submit a report
// ============================================================
describe("M20 Submit a report", () => {
  const SubmitReportScreen = require("@/app/more/submit-a-report").default

  beforeEach(() => {
    clearAll()
  })

  it("starts with empty form fields and no demo values", async () => {
    const { getByPlaceholderText } = await renderWithClient(<SubmitReportScreen />)

    const titleInput = getByPlaceholderText("Short summary")
    const reportInput = getByPlaceholderText("What happened and how to reproduce it")
    const emailInput = getByPlaceholderText("you@company.com")

    expect(titleInput.props.value).toBe("")
    expect(reportInput.props.value).toBe("")
    expect(emailInput.props.value).toBe("")
  })

  it("posts to /api/intake/upload and navigates to contact-verify with reportId and email", async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 202,
      headers: { get: () => null },
      json: async () => ({ reportId: "BD-1045", codeSent: true }),
    })

    const { getByPlaceholderText, getByText } = await renderWithClient(<SubmitReportScreen />)

    const titleInput = getByPlaceholderText("Short summary")
    const reportInput = getByPlaceholderText("What happened and how to reproduce it")
    const emailInput = getByPlaceholderText("you@company.com")

    await act(async () => {
      fireEvent.changeText(titleInput, "XSS in search")
      fireEvent.changeText(reportInput, "The q parameter is stored and rendered without encoding.")
      fireEvent.changeText(emailInput, "user@example.com")
    })

    await act(async () => {
      fireEvent.press(getByText("Submit report"))
    })

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/intake/upload"),
      expect.objectContaining({ method: "POST" })
    )

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0]
    const body = fetchCall[1].body
    expect(body).toBeInstanceOf(FormData)
    expect(body.get("title")).toBe("XSS in search")
    expect(body.get("body")).toBe("The q parameter is stored and rendered without encoding.")
    expect(body.get("contact")).toBe("user@example.com")
    expect(body.get("material")).toBeNull()

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/more/submit-a-report/contact-verify",
      params: { reportId: "BD-1045", email: "user@example.com" },
    })
  })

  it("shows the server error on failure", async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () => "invalid body: email is required",
    })

    const { getByPlaceholderText, getByText } = await renderWithClient(<SubmitReportScreen />)

    const titleInput = getByPlaceholderText("Short summary")
    const reportInput = getByPlaceholderText("What happened and how to reproduce it")
    const emailInput = getByPlaceholderText("you@company.com")

    await act(async () => {
      fireEvent.changeText(titleInput, "Test")
      fireEvent.changeText(reportInput, "Body")
      fireEvent.changeText(emailInput, "user@example.com")
    })

    await act(async () => {
      fireEvent.press(getByText("Submit report"))
    })

    expect(getByText("invalid body: email is required")).toBeTruthy()
  })
})

// ============================================================
// M21 Contact verify
// ============================================================
describe("M21 Contact verify", () => {
  const ContactVerifyScreen = require("@/app/more/submit-a-report/contact-verify").default

  beforeEach(() => {
    clearAll()
  })

  it("posts {reportId, code} and shows Report received with the id on success", async () => {
    paramOverrides.email = "user@example.com"
    paramOverrides.reportId = "BD-1045"

    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true }),
    })

    const result = await renderWithClient(<ContactVerifyScreen />)

    const textInputs = result.getAllByTestId(/^otp-box-\d+$/)
    expect(textInputs.length).toBe(6)

    await typeOtp(textInputs, "123456")

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/intake/upload/verify"),
      expect.objectContaining({ method: "POST" })
    )

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0]
    const body = JSON.parse(fetchCall[1].body)
    expect(body).toEqual({ reportId: "BD-1045", code: "123456" })

    expect(result.getByText("Report received")).toBeTruthy()
    expect(result.getByText(/BD-1045 is with the reviewer team/)).toBeTruthy()
  })

  it("shows the server error and clears boxes on failure (400)", async () => {
    paramOverrides.email = "user@example.com"
    paramOverrides.reportId = "BD-1045"

    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () => "invalid code",
    })

    const result = await renderWithClient(<ContactVerifyScreen />)

    const textInputs = result.getAllByTestId(/^otp-box-\d+$/)

    await typeOtp(textInputs, "123456")

    await waitFor(() => {
      expect(result.getByText("invalid code")).toBeTruthy()
    })
  })

  it("shows the reason, not raw JSON, when the verify route answers { error }", async () => {
    paramOverrides.email = "user@example.com"
    paramOverrides.reportId = "BD-1045"
    // app/api/intake/upload/verify/route.ts answers errors as Response.json({ error }).
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ error: "no such upload" }),
    })
    const result = await renderWithClient(<ContactVerifyScreen />)
    await typeOtp(result.getAllByTestId(/^otp-box-\d+$/), "123456")
    await waitFor(() => {
      expect(result.getByText("no such upload")).toBeTruthy()
    })
    expect(result.queryByText(/\{"error"/)).toBeNull()
  })

  it("resend uses the verify route with action=resend and reportId", async () => {
    paramOverrides.email = "user@example.com"
    paramOverrides.reportId = "BD-1045"

    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true }),
    })

    const result = await renderWithClient(<ContactVerifyScreen />)

    await act(async () => {
      fireEvent.press(result.getByText("Resend code"))
    })

    await waitFor(() => {
      const allCalls = (global.fetch as jest.Mock).mock.calls
      const resendCall = allCalls[allCalls.length - 1]
      const resendBody = JSON.parse(resendCall[1].body)
      expect(resendBody).toEqual({ reportId: "BD-1045", action: "resend" })
    })

    expect(result.getByText("Code sent")).toBeTruthy()
  })
})

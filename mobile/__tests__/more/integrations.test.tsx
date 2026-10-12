/**
 * Render tests for the M16-M25 screen group.
 */
import React from "react"
import { render, fireEvent } from "@testing-library/react-native"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const mockShow = jest.fn()
jest.mock("@/components/primitives", () => {
  const actual = jest.requireActual("@/components/primitives")
  return {
    ...actual,
    useToast: () => ({ show: mockShow }),
  }
})

const mockQueryResult: Record<string, { data?: unknown; error?: unknown; isPending: boolean }> = {}
jest.mock("@/lib/use-query", () => ({
  useApiQuery: (path: string) => mockQueryResult[path] ?? { data: undefined, error: undefined, isPending: true },
  useApiMutation: () => ({
    mutate: jest.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
  }),
  ApiError: class ApiError extends Error {
    status: number
    code?: string
    constructor(status: number, code?: string, message?: string) {
      super(message)
      this.status = status
      this.code = code
    }
  },
}))

jest.mock("@/components/SvgImage", () => ({
  SvgImage: ({ name, width, height }: { name: string; width: number; height: number }) => {
    const React = require("react")
    const { View } = require("react-native")
    return React.createElement(View, { testID: `svg-${name}`, width, height })
  },
}))

const mockRouterPush = jest.fn()
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
  Redirect: ({ href }: { href: string }) => {
    const React = require("react")
    const { View, Text } = require("react-native")
    return React.createElement(View, null, React.createElement(Text, null, `Redirect to ${href}`))
  },
}))

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({ signOut: jest.fn(), isSignedIn: true, isLoaded: true }),
}))

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}))

async function renderWithClient(component: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return await render(<QueryClientProvider client={queryClient}>{component}</QueryClientProvider>)
}

// ============================================================
// M16 Integrations
// ============================================================
describe("M16 Integrations", () => {
  const IntegrationsScreen = require("@/app/more/integrations").default

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders in loading state", async () => {
    mockQueryResult["/integrations"] = { data: undefined, error: undefined, isPending: true }
    const { getAllByText } = await renderWithClient(<IntegrationsScreen />)
    expect(getAllByText("Integrations").length).toBeGreaterThan(0)
    expect(getAllByText("Where reports come in and verdicts go out").length).toBeGreaterThan(0)
  })

  it("renders data state with channels from the real integration rows", async () => {
    // Shape copied from IntegrationRow in app/(app)/integrations/integration-list.tsx.
    mockQueryResult["/integrations"] = {
      data: [
        { id: "email", name: "Email", detail: "Reviewers on the allowlist", icon: "mail", installed: true, action: { kind: "none", label: "Built in" } },
        { id: "github", name: "GitHub", detail: "2 repositories, 1 accepting reports", icon: "github", installed: true, action: { kind: "link", href: "/connections", label: "Manage" } },
        { id: "upload", name: "Upload", detail: "The public submit page", icon: "upload", installed: false, action: { kind: "none", label: "Not set up" } },
      ],
      error: undefined,
      isPending: false,
    }
    mockQueryResult["/integrations/email"] = {
      data: [{ email: "alex@example.com", role: "owner", verified: true, codeOutstanding: false, addedByEmail: null, createdAt: null }],
      error: undefined,
      isPending: false,
    }
    const { getByText, getAllByText } = await renderWithClient(<IntegrationsScreen />)
    expect(getByText("Channels")).toBeTruthy()
    expect(getByText("1 reviewer verified")).toBeTruthy()
    expect(getByText("2 repositories, 1 accepting reports")).toBeTruthy()
    expect(getByText("Active")).toBeTruthy()
    expect(getByText("Connected")).toBeTruthy()
    expect(getByText("Not configured")).toBeTruthy()
  })

  it("shows no sample rows when the server returns none", async () => {
    mockQueryResult["/integrations"] = { data: [], error: undefined, isPending: false }
    mockQueryResult["/integrations/email"] = { data: [], error: undefined, isPending: false }
    const { queryByText } = await renderWithClient(<IntegrationsScreen />)
    expect(queryByText("GitHub")).toBeNull()
    expect(queryByText("1 installation")).toBeNull()
  })

  it("shows the error when /integrations fails", async () => {
    mockQueryResult["/integrations"] = { data: undefined, error: new Error("integrations unavailable"), isPending: false }
    const { getByText } = await renderWithClient(<IntegrationsScreen />)
    expect(getByText("integrations unavailable")).toBeTruthy()
  })
})

// ============================================================
// M17 Email access
// ============================================================
describe("M17 Email access", () => {
  const EmailAccessScreen = require("@/app/more/integrations/email-access").default

  beforeEach(() => {
    jest.clearAllMocks()
    mockQueryResult["/me"] = {
      data: { allowlisted: true, login: "alex", email: "alex@example.com", avatarUrl: null, role: "owner" },
      error: undefined,
      isPending: false,
    }
  })

  it("renders in loading state", async () => {
    mockQueryResult["/integrations/email"] = { data: undefined, error: undefined, isPending: true }
    const { getAllByText } = await renderWithClient(<EmailAccessScreen />)
    expect(getAllByText("Email access").length).toBeGreaterThan(0)
    expect(getAllByText("Reviewer allowlist").length).toBeGreaterThan(0)
  })

  it("renders data state with reviewers", async () => {
    mockQueryResult["/integrations/email"] = {
      data: [
        { email: "alex@example.com", role: "owner", verified: true, codeOutstanding: false, addedByEmail: null, createdAt: "2024-01-01" },
        { email: "sam@example.com", role: "member", verified: true, codeOutstanding: false, addedByEmail: null, createdAt: "2024-01-02" },
        { email: "priya@example.com", role: "member", verified: false, codeOutstanding: true, addedByEmail: null, createdAt: "2024-01-03" },
      ],
      error: undefined,
      isPending: false,
    }
    const { getByText, getAllByText } = await renderWithClient(<EmailAccessScreen />)
    expect(getAllByText("Reviewers").length).toBeGreaterThan(0)
    expect(getByText("alex@example.com")).toBeTruthy()
    expect(getAllByText("Owner").length).toBeGreaterThan(0)
    expect(getAllByText("Verified").length).toBeGreaterThan(0)
    expect(getAllByText("Pending").length).toBeGreaterThan(0)
    expect(getByText("Add reviewer")).toBeTruthy()
    expect(getByText("Verify with a code")).toBeTruthy()
  })

  it("opens the code screen with the pending reviewer's address", async () => {
    mockQueryResult["/integrations/email"] = {
      data: [
        { email: "priya@example.com", role: "member", verified: false, codeOutstanding: true, addedByEmail: null, createdAt: null },
      ],
      error: undefined,
      isPending: false,
    }
    const { getByText } = await renderWithClient(<EmailAccessScreen />)
    await fireEvent.press(getByText("Verify with a code"))
    expect(mockRouterPush).toHaveBeenCalledWith({ pathname: "/more/integrations/otp-verify", params: { email: "priya@example.com" } })
  })

  it("keeps Verify with a code visible but opens nothing when no reviewer has a code outstanding", async () => {
    mockQueryResult["/integrations/email"] = {
      data: [{ email: "alex@example.com", role: "owner", verified: true, codeOutstanding: false, addedByEmail: null, createdAt: null }],
      error: undefined,
      isPending: false,
    }
    const { getByText } = await renderWithClient(<EmailAccessScreen />)
    mockRouterPush.mockClear()
    await fireEvent.press(getByText("Verify with a code"))
    expect(mockRouterPush).not.toHaveBeenCalled()
  })

  it("renders empty state when no reviewers", async () => {
    mockQueryResult["/integrations/email"] = { data: [], error: undefined, isPending: false }
    const { getAllByText } = await renderWithClient(<EmailAccessScreen />)
    expect(getAllByText("Reviewers").length).toBeGreaterThan(0)
  })
})

// ============================================================
// M18 OTP verify
// ============================================================
describe("M18 OTP verify", () => {
  const OtpVerifyScreen = require("@/app/more/integrations/otp-verify").default

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders title and email meta", async () => {
    const { getAllByText } = await renderWithClient(<OtpVerifyScreen />)
    expect(getAllByText("Verify your email").length).toBeGreaterThan(0)
  })

  it("renders six OTP boxes", async () => {
    const { getAllByDisplayValue } = await renderWithClient(<OtpVerifyScreen />)
    const inputs = getAllByDisplayValue("")
    expect(inputs.length).toBe(6)
  })

  it("shows resend and note text", async () => {
    const { getByText } = await renderWithClient(<OtpVerifyScreen />)
    expect(getByText("Resend code")).toBeTruthy()
    expect(getByText(/The code expires in 10 minutes/)).toBeTruthy()
  })
})

// ============================================================
// M19 Settings
// ============================================================
describe("M19 Settings", () => {
  const SettingsScreen = require("@/app/more/index").default

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders in loading state", async () => {
    mockQueryResult["/me"] = { data: undefined, error: undefined, isPending: true }
    const { getAllByText } = await renderWithClient(<SettingsScreen />)
    expect(getAllByText("Settings").length).toBeGreaterThan(0)
    expect(getAllByText("Account and workspace").length).toBeGreaterThan(0)
  })

  it("renders data state with account and theme", async () => {
    mockQueryResult["/me"] = {
      data: { allowlisted: true, login: "alex", email: "alex@example.com", avatarUrl: null, role: "owner" },
      error: undefined,
      isPending: false,
    }
    const { getByText, getAllByText, queryByText } = await renderWithClient(<SettingsScreen />)
    expect(getByText("alex")).toBeTruthy()
    expect(getByText("alex@example.com")).toBeTruthy()
    expect(queryByText("Theme")).toBeNull()
    expect(getByText("Connections")).toBeTruthy()
    expect(getByText("Integrations")).toBeTruthy()
    expect(getByText("Target and scope")).toBeTruthy()
    expect(getAllByText("Privacy").length).toBeGreaterThan(0)
    expect(getAllByText("Terms").length).toBeGreaterThan(0)
    expect(getAllByText("Sign out").length).toBeGreaterThan(0)
  })

  it("renders notification toggles", async () => {
    mockQueryResult["/me"] = {
      data: { allowlisted: true, login: "alex", email: "alex@example.com", avatarUrl: null, role: "owner" },
      error: undefined,
      isPending: false,
    }
    const { getByText } = await renderWithClient(<SettingsScreen />)
    expect(getByText("Approvals needed")).toBeTruthy()
    expect(getByText("Delivery receipts")).toBeTruthy()
    expect(getByText("Reproduction failures")).toBeTruthy()
  })
})

// ============================================================
// M20 Submit a report
// ============================================================
describe("M20 Submit a report", () => {
  const SubmitReportScreen = require("@/app/more/submit-a-report").default

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders form fields", async () => {
    const { getByPlaceholderText } = await renderWithClient(<SubmitReportScreen />)
    expect(getByPlaceholderText("Short summary")).toBeTruthy()
    expect(getByPlaceholderText("What happened and how to reproduce it")).toBeTruthy()
    expect(getByPlaceholderText("you@company.com")).toBeTruthy()
  })

  it("shows the submit button", async () => {
    const { getByText } = await renderWithClient(<SubmitReportScreen />)
    expect(getByText("Submit report")).toBeTruthy()
  })

  it("shows target material sheet trigger", async () => {
    const { getByText } = await renderWithClient(<SubmitReportScreen />)
    expect(getByText("Add target material")).toBeTruthy()
    expect(getByText("None selected")).toBeTruthy()
  })
})

// ============================================================
// M21 Contact verify
// ============================================================
describe("M21 Contact verify", () => {
  const ContactVerifyScreen = require("@/app/more/submit-a-report/contact-verify").default

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders title and email meta", async () => {
    const { getAllByText } = await renderWithClient(<ContactVerifyScreen />)
    expect(getAllByText("Verify your contact").length).toBeGreaterThan(0)
  })

  it("renders six OTP boxes", async () => {
    const { getAllByDisplayValue } = await renderWithClient(<ContactVerifyScreen />)
    const inputs = getAllByDisplayValue("")
    expect(inputs.length).toBe(6)
  })

  it("shows note and resend button", async () => {
    const { getByText } = await renderWithClient(<ContactVerifyScreen />)
    expect(getByText("Resend code")).toBeTruthy()
    expect(getByText(/The code is only valid for this report/)).toBeTruthy()
  })
})

// ============================================================
// M23 Inbox
// ============================================================
describe("M23 Inbox", () => {
  const InboxScreen = require("@/app/inbox").default

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders in loading state", async () => {
    mockQueryResult["/inbox"] = { data: undefined, error: undefined, isPending: true }
    const { getAllByText } = await renderWithClient(<InboxScreen />)
    expect(getAllByText("Inbox").length).toBeGreaterThan(0)
  })

  it("renders real inbox rows with upper-case states and the short report id", async () => {
    // Shape copied from InboxCard in lib/mobile/views.ts: state is the report enum, deliveryState is
    // PENDING | SENT | FAILED, and id is the report uuid.
    mockQueryResult["/inbox"] = {
      data: {
        needsYou: {
          items: [
            { id: "11111111-aaaa-bbbb-cccc-000000000001", title: "Stored XSS", sourceLabel: "#482", channel: "github", targetName: "t", outcome: "REPRODUCED", verdictSuperseded: false, deliveryState: null, state: "AWAITING_APPROVAL", awaitingVerdictId: "v-1", updatedAt: new Date().toISOString() },
          ],
          total: 1,
          nextOffset: null,
        },
        earlier: {
          items: [
            { id: "11111111-aaaa-bbbb-cccc-000000000002", title: "Reflected XSS", sourceLabel: "#470", channel: "github", targetName: "t", outcome: "REPRODUCED", verdictSuperseded: false, deliveryState: "SENT", state: "DELIVERED", awaitingVerdictId: null, updatedAt: new Date().toISOString() },
            { id: "11111111-aaaa-bbbb-cccc-000000000003", title: "Open redirect", sourceLabel: "#465", channel: "email", targetName: null, outcome: null, verdictSuperseded: false, deliveryState: "SENT", state: "DELIVERING", awaitingVerdictId: null, updatedAt: new Date().toISOString() },
            { id: "11111111-aaaa-bbbb-cccc-000000000004", title: "CSRF", sourceLabel: "#460", channel: "email", targetName: null, outcome: null, verdictSuperseded: false, deliveryState: "FAILED", state: "ANALYSIS_ONLY", awaitingVerdictId: null, updatedAt: new Date().toISOString() },
          ],
          total: 3,
          nextOffset: null,
          truncated: false,
        },
      },
      error: undefined,
      isPending: false,
    }
    const { getByText, getAllByText } = await renderWithClient(<InboxScreen />)
    expect(getByText("1 need you")).toBeTruthy()
    expect(getByText("#482 · Approval needed")).toBeTruthy()
    expect(getByText("#470 · Delivered to GitHub")).toBeTruthy()
    expect(getByText("#465 · Waiting for the receipt")).toBeTruthy()
    expect(getAllByText("Delivered").length).toBeGreaterThan(0)
    expect(getByText("Delivering")).toBeTruthy()
    expect(getByText("Failed")).toBeTruthy()
  })

  it("shows an empty state and no sample cards when nothing needs you", async () => {
    mockQueryResult["/inbox"] = { data: { needsYou: { items: [], total: 0, nextOffset: null }, earlier: null }, error: undefined, isPending: false }
    const { getByText, queryByText } = await renderWithClient(<InboxScreen />)
    expect(getByText("0 need you")).toBeTruthy()
    expect(getByText("Nothing needs you")).toBeTruthy()
    expect(queryByText("Stored XSS in search results")).toBeNull()
  })

  it("shows the error on a non-auth failure", async () => {
    const { ApiError } = require("@/lib/use-query")
    mockQueryResult["/inbox"] = {
      data: undefined,
      error: new ApiError(500, "err-server", "upstream timeout"),
      isPending: false,
    }
    const { getByText, queryByText } = await renderWithClient(<InboxScreen />)
    expect(getByText("upstream timeout")).toBeTruthy()
    expect(queryByText("Needs you")).toBeNull()
  })

  it("returns null for auth error", async () => {
    const { ApiError } = require("@/lib/use-query")
    mockQueryResult["/inbox"] = {
      data: undefined,
      error: new ApiError(401, "unauthenticated", "unauthenticated"),
      isPending: false,
    }
    const result = await renderWithClient(<InboxScreen />)
    expect(result.toJSON()).toBeNull()
  })
})

// ============================================================
// M24 Privacy
// ============================================================
describe("M24 Privacy", () => {
  const PrivacyScreen = require("@/app/more/privacy").default

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders title and meta", async () => {
    const { getAllByText } = await renderWithClient(<PrivacyScreen />)
    expect(getAllByText("Privacy").length).toBeGreaterThan(0)
    expect(getAllByText("Last updated September 2026").length).toBeGreaterThan(0)
  })

  it("renders article sections", async () => {
    const { getByText } = await renderWithClient(<PrivacyScreen />)
    expect(getByText("Signing in")).toBeTruthy()
    expect(getByText("What the system stores")).toBeTruthy()
    expect(getByText("GitHub access")).toBeTruthy()
    expect(getByText("Retention")).toBeTruthy()
    expect(getByText("Contact")).toBeTruthy()
  })
})

// ============================================================
// M25 Terms
// ============================================================
describe("M25 Terms", () => {
  const TermsScreen = require("@/app/more/terms").default

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders title and meta", async () => {
    const { getAllByText } = await renderWithClient(<TermsScreen />)
    expect(getAllByText("Terms").length).toBeGreaterThan(0)
    expect(getAllByText("Last updated September 2026").length).toBeGreaterThan(0)
  })

  it("renders article sections", async () => {
    const { getByText } = await renderWithClient(<TermsScreen />)
    expect(getByText("Authorized targets only")).toBeTruthy()
    expect(getByText("Provided as is")).toBeTruthy()
    expect(getByText("Contact")).toBeTruthy()
  })
})

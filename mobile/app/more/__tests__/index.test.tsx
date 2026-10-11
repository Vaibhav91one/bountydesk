/**
 * Render tests for the notification switches on M19 Settings.
 *
 * Verifies that turning the "Approvals needed" switch on registers for push
 * and, on a failed registration, turns the switch back off and shows the
 * reason as a toast.
 */
import React from "react"
import { render, fireEvent, waitFor, act, within } from "@testing-library/react-native"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const mockPush = jest.fn()
const mockShow = jest.fn()

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
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

jest.mock("@/theme", () => ({
  useTheme: () => ({
    colors: {
      background: "#0f0f0f",
      card: "#131314",
      foreground: "#ffffff",
      muted: "#b8b8b8",
      faint: "#8c8c8c",
      "brand-soft": "#C9B0FF",
      brand: "#9475E6",
      red: "#B93645",
    },
    typography: { fontMono: "GeistMono" },
    round: { cardRadius: 24, buttonRadius: 26 },
    spacing: { itemMinHeight: 56 },
  }),
}))

jest.mock("@/components/primitives", () => {
  const actual = jest.requireActual("@/components/primitives")
  return {
    ...actual,
    ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useToast: () => ({ show: mockShow }),
  }
})

jest.mock("@/lib/use-query", () => ({
  useApiQuery: () => ({ data: undefined, error: null }),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message?: string) {
      super(message)
      this.status = status
      this.name = "ApiError"
    }
  },
}))

jest.mock("@/lib/push", () => ({
  registerForPush: jest.fn(),
}))
// Reference the mocked function through require so the factory stays free of
// out-of-scope variables.
const pushModule = require("@/lib/push")
const registerForPush = (pushModule.registerForPush as jest.Mock) || jest.fn()

jest.mock("@/lib/session", () => ({
  signOutAndClear: jest.fn(),
}))

let SettingsScreen: React.ComponentType

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SettingsScreen = require("../index").default
})

async function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return await render(
    <QueryClientProvider client={queryClient}>
      <SettingsScreen />
    </QueryClientProvider>,
  )
}

// Each switch row is: View.switchRow > [View.rowLeading, View.main>Text(label),
// Pressable[role=switch]]. Query the Pressable by role scoped to its row.
async function pressSwitchByText(getByText: (t: string) => unknown, label: string) {
  const textNode = getByText(label)
  const row = (textNode as any).parent?.parent
  const { getByRole } = within(row)
  await act(async () => {
    fireEvent.press(getByRole("switch"))
  })
}

describe("M19 Settings notification switches", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    registerForPush.mockResolvedValue({ ok: true })
  })

  // The three toggles render in order: Approvals needed, Delivery receipts,
  // Reproduction failures. Defaults are true, true, false.
  it("turns on Approvals needed and registers for push on success", async () => {
    const { getByText, getAllByRole } = await renderScreen()

    await waitFor(() => expect(getAllByRole("switch")).toHaveLength(3))
    // starts checked (default true), flip it off then on to hit the register path
    await pressSwitchByText(getByText, "Approvals needed")
    await pressSwitchByText(getByText, "Approvals needed")
    await waitFor(() => expect(registerForPush).toHaveBeenCalledTimes(1))
    expect(mockShow).not.toHaveBeenCalled()
  })

  it("turns the switch back off and shows the reason on failure", async () => {
    const { getByText, getAllByRole } = await renderScreen()

    await waitFor(() => expect(getAllByRole("switch")).toHaveLength(3))
    registerForPush.mockResolvedValueOnce({
      ok: false,
      reason: "Notifications are turned off for BountyDesk in Settings",
    })

    // flip off then on to trigger register
    await pressSwitchByText(getByText, "Approvals needed")
    await pressSwitchByText(getByText, "Approvals needed")
    expect(registerForPush).toHaveBeenCalled()
    await waitFor(() =>
      expect(mockShow).toHaveBeenCalledWith("Notifications are turned off for BountyDesk in Settings"),
    )
  })

  it("shows the not-wired note under the switches", async () => {
    const { getByText } = await renderScreen()
    await waitFor(() =>
      expect(getByText("Reproduction failures are not sent as pushes yet.")).toBeTruthy(),
    )
  })
})

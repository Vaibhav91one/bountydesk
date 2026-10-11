/**
 * M15 connection detail has an Onboarding row that routes to the new path.
 */
import React from "react"
import { render, fireEvent, waitFor } from "@testing-library/react-native"

import type { ConnectionRow } from "@/lib/types"

const mockPush = jest.fn()
const mockRoutes = { id: "123" }

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useLocalSearchParams: () => mockRoutes,
}))

const mockUseApiQuery = jest.fn()
jest.mock("@/lib/use-query", () => ({
  useApiQuery: (path: string) => mockUseApiQuery(path),
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

jest.mock("@/theme", () => ({
  useTheme: () => ({
    colors: {
      background: "#000",
      foreground: "#fff",
      muted: "#888",
      faint: "#444",
      fill: "#222",
      brand: "#6774F0",
      "brand-soft": "#aaa",
      red: "#EA3A3A",
      card: "#111",
      line: "#222",
      raised: "#222",
      "glass-edge": "#333",
      glass: "#111",
      "sheet-card": "#111",
    },
    spacing: { itemMinHeight: 56 },
    typography: { fontMono: "GeistMono" },
    round: { cardRadius: 24 },
  }),
}))

jest.mock("@/components/icons", () => ({
  Icon: ({ name }: { name: string }) => {
    const React = require("react")
    const { Text } = require("react-native")
    return React.createElement(Text, { "data-testid": `icon-${name}` }, name)
  },
}))

jest.mock("@/components/primitives", () => {
  const React = require("react")
  const { View, Text, Pressable } = require("react-native")
  return {
    Card: ({ children, style }: any) => React.createElement(View, { style }, children),
    KvRow: ({ label, value }: any) =>
      React.createElement(View, { "data-testid": "kvrow" },
        React.createElement(Text, {}, label),
        React.createElement(Text, {}, typeof value === "string" ? value : "value"),
      ),
    SectionHeader: ({ title }: any) => React.createElement(Text, { "data-testid": `section-${title}` }, title),
    ScreenHeader: ({ title }: any) => React.createElement(Text, { "data-testid": "screenheader" }, title),
    Mono: ({ children }: any) => React.createElement(Text, {}, children),
    EmptyState: ({ heading }: any) => React.createElement(Text, { "data-testid": "emptystate" }, heading),
  }
})

import ConnectionDetailScreen from "../[id]/index"

const BASE_ROW: ConnectionRow = {
  id: "repo-1",
  account: "test",
  status: "admissible",
  fullName: "test/repo",
  owner: "test",
  name: "repo",
  label: "Connected",
  hint: "Reports opened here are accepted.",
  target: "test/repo",
  repoId: 123,
  configured: true,
  connected: true,
  isPrivate: false,
  reportCount: 1,
  awaitingReview: 0,
  delivered: 0,
  lastReportAt: null,
  lastSyncedAt: "2024-01-01T00:00:00Z",
  manageUrl: null,
  onboarding: null,
  onboardingProgress: null,
  onboardingDetail: null,
}

describe("M15 ConnectionDetailScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("has an Onboarding row that routes to the new path", async () => {
    mockUseApiQuery.mockReturnValue({
      data: [{ ...BASE_ROW }],
      error: undefined,
    })

    const { getByText, getByTestId } = await render(<ConnectionDetailScreen />)

    await waitFor(() => {
      expect(getByTestId("onboarding-row")).toBeTruthy()
    })

    const row = getByTestId("onboarding-row")
    await fireEvent.press(row)

    expect(mockPush).toHaveBeenCalledWith("/more/connections/123/onboarding")
  })
})

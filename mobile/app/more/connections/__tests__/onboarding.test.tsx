/**
 * M27 onboarding renders the connection's real onboarding record.
 * The screen fetches GET /api/mobile/v1/connections and finds the row by repoId.
 */
import React from "react"
import { render, waitFor } from "@testing-library/react-native"

import type { ConnectionRow } from "@/lib/types"

const mockPush = jest.fn()
const mockRoutes = { id: "123" }

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
  useLocalSearchParams: () => mockRoutes,
}))

// Mock useApiQuery to return controlled rows.
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
        React.createElement(Text, { "data-testid": `kvlabel-${label}` }, label),
        React.createElement(Text, { "data-testid": `kvvalue-${label}` }, value),
      ),
    SectionHeader: ({ title }: any) => React.createElement(Text, { "data-testid": `section-${title}` }, title),
    ScreenHeader: () => null,
    ScreenTitle: ({ title }: any) => React.createElement(Text, { "data-testid": "screenheader" }, title),
    Mono: ({ children, style }: any) => React.createElement(Text, { style, "data-testid": "mono" }, children),
    EmptyState: ({ heading }: any) => React.createElement(Text, { "data-testid": "emptystate" }, heading),
  }
})

import OnboardingScreen from "../[id]/onboarding"

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
  contentsPermission: null,
  advisoriesPermission: "write",
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

describe("M27 OnboardingScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders the stage diagram, the short commit and the status from a real-shaped row", async () => {
    const detail = {
      state: "CONFIGURED",
      progressNote: null,
      reason: null,
      strategy: "docker",
      ecosystem: "node",
      imageName: "ghcr.io/test/repo",
      imageDigest: "sha256:abcdef1234567890abcdef1234567890abcdef12",
      buildMarker: "1867b926c5f50e4e692dc9c8f61821413cebe0cd",
      approvedBy: "alice",
      approvedAt: "2024-01-01T00:00:00Z",
      review: null,
      hasDockerfile: true,
      hasBuildLog: false,
      hasManifest: true,
      hasBuildPlan: true,
    }
    mockUseApiQuery.mockReturnValue({
      data: [{ ...BASE_ROW, fullName: "test/repo", onboardingDetail: detail, onboarding: null }],
      error: undefined,
    })

    const { getByText, queryAllByText } = await render(<OnboardingScreen />)

    await waitFor(() => {
      // Stage 1 names the repository
      expect(getByText("test/repo at the pinned commit")).toBeTruthy()
    })

    // buildMarker first 7 chars shown in the Commit row
    expect(queryAllByText("1867b92")).toHaveLength(1)
    expect(getByText("Configured")).toBeTruthy()
  })

  it("shows no 'Connection not found' while the connections list is still loading", async () => {
    mockUseApiQuery.mockReturnValue({ data: undefined, error: undefined })
    const { queryByText } = await render(<OnboardingScreen />)
    expect(queryByText("Connection not found")).toBeNull()
    expect(queryByText("Not onboarded yet")).toBeNull()
  })

  it("shows the reason when onboardingProgress state is FAILED", async () => {
    mockUseApiQuery.mockReturnValue({
      data: [{
        ...BASE_ROW,
        onboardingProgress: { state: "FAILED", reason: "build exceeded 10 minutes" },
        onboardingDetail: null,
      }],
      error: undefined,
    })

    const { getByText } = await render(<OnboardingScreen />)

    await waitFor(() => {
      expect(getByText("build exceeded 10 minutes")).toBeTruthy()
    })
  })

  it("shows 'Not onboarded yet' when there is no onboarding record", async () => {
    mockUseApiQuery.mockReturnValue({
      data: [{ ...BASE_ROW }],
      error: undefined,
    })

    const { getByText } = await render(<OnboardingScreen />)

    await waitFor(() => {
      expect(getByText("Not onboarded yet")).toBeTruthy()
    })
  })
})

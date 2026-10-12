/** M23 Inbox: the failed row names the server's failure reason and falls back when it sends none. */
import React from "react"
import { render } from "@testing-library/react-native"

let mockData: unknown

jest.mock("@/lib/use-query", () => ({
  useApiQuery: () => ({ data: mockData, error: null }),
  ApiError: class ApiError extends Error {},
}))
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn() }) }))
jest.mock("@/theme", () => ({
  useTheme: () => ({
    colors: {
      background: "#0f0f0f", card: "#131314", foreground: "#fff", muted: "#b8b8b8", faint: "#8c8c8c",
      line: "rgba(255,255,255,0.08)", glass: "rgba(15,15,17,0.6)", "glass-edge": "rgba(255,255,255,0.10)",
      fill: "rgba(255,255,255,0.10)", brand: "#9475E6", "brand-soft": "#C9B0FF", red: "#B93645",
    },
    phase: { triaging: "#B49AFF", reproducing: "#9DB6FF", analysis: "#E0B0FF", approval: "#F1D06B", delivered: "#7CD8A0", closed: "#888888" },
    spacing: { itemMinHeight: 56 },
    round: { cardRadius: 24, buttonRadius: 26 },
  }),
}))

const failed = (failureReason?: string | null) => ({
  needsYou: { items: [], total: 0, nextOffset: null },
  earlier: {
    items: [{
      id: "r1", title: "Open redirect on /redirect", sourceLabel: "BD-1039", channel: "github", targetName: "juice-shop",
      outcome: null, verdictSuperseded: false, deliveryState: "FAILED", state: "ANALYSIS_ONLY",
      awaitingVerdictId: null, updatedAt: new Date().toISOString(), ...(failureReason === undefined ? {} : { failureReason }),
    }],
    total: 1,
    nextOffset: null,
  },
})

describe("M23 Inbox failed row", () => {
  const Inbox = () => React.createElement(require("../app/inbox").default)

  it("shows the failure reason", async () => {
    mockData = failed("Target did not start")
    expect((await render(<Inbox />)).getByText("BD-1039 · Target did not start")).toBeTruthy()
  })

  it.each([null, undefined])("falls back to Delivery failed when the reason is %s", async (reason) => {
    mockData = failed(reason)
    expect((await render(<Inbox />)).getByText("BD-1039 · Delivery failed")).toBeTruthy()
  })
})

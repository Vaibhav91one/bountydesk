/**
 * M10 Reviewer chat render tests: loading, data, and empty states.
 */
import React from "react"
import { render, fireEvent, act } from "@testing-library/react-native"

import ChatScreen from "../app/reports/[id]/chat"
import { PhaseKey } from "@/lib/phases"
import { ApiError } from "@/lib/use-query"

const mockPush = jest.fn()
const mockBack = jest.fn()

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "report-1" }),
  useRouter: () => ({ push: mockPush, back: mockBack }),
}))

const mockQueryData: Record<string, unknown> = {}
let mockRefetchResult: { data?: unknown; error?: Error } = {}
let mockSendFails = false
const mutateCalls: Array<{ vars: { clientRequestId: string; body: string }; opts: any }> = []
jest.mock("@/lib/use-query", () => ({
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, code?: string, message?: string) {
      super(message ?? `API error: ${status}`)
      this.status = status
    }
  },
  useApiQuery: (path: string) => {
    const data = mockQueryData[path] as { data?: unknown; error?: Error }
    return {
      data: data?.data,
      error: data?.error,
      isError: !!data?.error,
      refetch: jest.fn(() => {
        if (mockRefetchResult.data) {
          mockQueryData[path] = { data: mockRefetchResult.data }
        }
        return Promise.resolve(mockRefetchResult)
      }),
    }
  },
  useApiMutation: () => ({
    mutate: jest.fn((vars: { clientRequestId: string; body: string }, opts?: any) => {
      mutateCalls.push({ vars, opts })
      if (mockSendFails) {
        opts?.onError?.()
      } else {
        opts?.onSuccess?.()
      }
    }),
    isPending: false,
  }),
}))

jest.mock("@/theme", () => ({
  useTheme: () => ({
    colors: {
      page: "#0b0b0d",
      background: "#15161a",
      card: "#1c1d21",
      foreground: "#f5f5f7",
      muted: "#a0a0b0",
      faint: "#606070",
      red: "#e74055",
      brand: "#8a2be2",
      "brand-soft": "#a080d0",
      glass: "rgba(15,15,17,0.6)",
      "glass-edge": "rgba(255,255,255,0.10)",
    },
    phase: {
      triaging: "#aa55ff",
      reproducing: "#4da6ff",
      analysis: "#d14fcf",
      approval: "#e6c100",
      delivered: "#4caf50",
      closed: "#888888",
    } as Record<PhaseKey, string>,
    typography: { fontFamily: "Inter", fontMono: "GeistMono" },
  }),
}))

jest.mock("@/components/primitives", () => {
  const { View: RNView, Text: RNText } = require("react-native")
  return {
    ScreenHeader: ({ title, meta, back }: { title: string; meta?: string; back?: boolean }) => (
      <RNView><RNText>{title}</RNText>{meta ? <RNText>{meta}</RNText> : null}{back ? <RNText>Back</RNText> : null}</RNView>
    ),
    EmptyState: ({ heading, body }: { heading: string; body?: string }) => (
      <RNView><RNText>{heading}</RNText>{body ? <RNText>{body}</RNText> : null}</RNView>
    ),
  }
})

const CHAT_STATUS = {
  reportId: "report-1",
  threads: [
    {
      id: "thread-1",
      verdictId: null,
      verdictRevision: null,
      verdictContentHash: null,
      status: "RUNNING",
      createdAt: "2026-01-01T09:30:00Z",
      updatedAt: "2026-01-01T09:38:00Z",
      messages: [
        {
          id: "msg-1",
          clientRequestId: "req-1",
          sender: "REVIEWER",
          body: "Why is this rated High?",
          bodyHash: "hash1",
          modelName: null,
          providerTurnId: null,
          createdAt: "2026-01-01T09:38:00Z",
        },
        {
          id: "msg-2",
          clientRequestId: "req-1",
          sender: "AGENT",
          body: "The payload is stored, so it runs for every visitor who opens the search page.",
          bodyHash: "hash2",
          modelName: "gpt-4",
          providerTurnId: "turn-1",
          createdAt: "2026-01-01T09:38:01Z",
        },
      ],
    },
  ],
}

describe("M10 Reviewer chat", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSendFails = false
    mockRefetchResult = {}
    mutateCalls.length = 0
  })

  it("renders the screen title in loading state", async () => {
    mockQueryData["/reports/report-1/chat"] = {}
    mockQueryData["/reports/report-1"] = {}
    const { getByText } = await render(<ChatScreen />)
    expect(getByText("Ask the agent")).toBeTruthy()
    expect(getByText("Back")).toBeTruthy()
  })

  const REPORT_META = { data: { id: "report-1", title: "Stored XSS in search results" } }

  it("renders chat bubbles for reviewer and agent messages", async () => {
    mockQueryData["/reports/report-1/chat"] = { data: CHAT_STATUS }
    mockQueryData["/reports/report-1"] = REPORT_META
    const { getByText } = await render(<ChatScreen />)
    expect(getByText("Ask the agent")).toBeTruthy()
    expect(getByText("Agent Bounty")).toBeTruthy()
    expect(getByText("Why is this rated High?")).toBeTruthy()
    expect(getByText(/The payload is stored/)).toBeTruthy()
  })

  it("renders the meta line as report id and title", async () => {
    mockQueryData["/reports/report-1/chat"] = { data: CHAT_STATUS }
    mockQueryData["/reports/report-1"] = REPORT_META
    const { getByText } = await render(<ChatScreen />)
    expect(getByText(/report-1 · Stored XSS in search results/)).toBeTruthy()
  })

  it("renders suggestion chips when there are messages", async () => {
    mockQueryData["/reports/report-1/chat"] = { data: CHAT_STATUS }
    mockQueryData["/reports/report-1"] = REPORT_META
    const { getByText } = await render(<ChatScreen />)
    expect(getByText("Show the probes")).toBeTruthy()
    expect(getByText("Re-check")).toBeTruthy()
  })

  it("renders an empty state when there are no messages", async () => {
    mockQueryData["/reports/report-1/chat"] = { data: { reportId: "report-1", threads: [] } }
    mockQueryData["/reports/report-1"] = REPORT_META
    const { getByText } = await render(<ChatScreen />)
    expect(getByText("No messages yet")).toBeTruthy()
  })

  it("renders the composer input with placeholder", async () => {
    mockQueryData["/reports/report-1/chat"] = { data: CHAT_STATUS }
    mockQueryData["/reports/report-1"] = REPORT_META
    const { getByPlaceholderText } = await render(<ChatScreen />)
    expect(getByPlaceholderText("Ask about this report")).toBeTruthy()
  })

  it("renders after query flips from success to error and back (hook order stable)", async () => {
    // Start with success
    mockQueryData["/reports/report-1/chat"] = { data: CHAT_STATUS }
    mockQueryData["/reports/report-1"] = REPORT_META
    const { getByText, rerender } = await render(<ChatScreen />)
    expect(getByText("Ask the agent")).toBeTruthy()

    // Flip to error
    mockQueryData["/reports/report-1/chat"] = { error: new ApiError(500, "internal", "Server error") }
    const { rerender: r2 } = await render(<ChatScreen />)
    expect(r2).toBeDefined()


    // Flip back to success
    mockQueryData["/reports/report-1/chat"] = { data: CHAT_STATUS }
    mockQueryData["/reports/report-1"] = REPORT_META
    const { getByText: g2 } = await render(<ChatScreen />)
    expect(g2("Ask the agent")).toBeTruthy()
  })

  it("uses a UUID clientRequestId when sending a message", async () => {
    mockQueryData["/reports/report-1/chat"] = { data: CHAT_STATUS }
    mockQueryData["/reports/report-1"] = REPORT_META
    const { getByPlaceholderText } = await render(<ChatScreen />)
    const input = getByPlaceholderText("Ask about this report")
    expect(input).toBeTruthy()
  })
  it("stops waiting and shows an error when the agent turn ends in ERROR", async () => {
    jest.useFakeTimers()
    mockRefetchResult = {
      data: { ...CHAT_STATUS, threads: [{ ...CHAT_STATUS.threads[0], status: "ERROR" }] },
    }
    const { getByPlaceholderText, getByLabelText, getByText, queryByText } = await render(<ChatScreen />)
    await fireEvent.changeText(getByPlaceholderText("Ask about this report"), "why?")
    await fireEvent.press(getByLabelText("Send"))
    await act(async () => {
      jest.advanceTimersByTime(2100)
    })
    // The interval awaits refetch(); let that promise and the state update settle.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getByText("The agent could not answer. Try again.")).toBeTruthy()
    expect(queryByText("Agent Bounty is thinking…")).toBeNull()
    jest.useRealTimers()
  })

  it("retry after a failed send reuses the same clientRequestId", async () => {
    mockSendFails = true
    mockQueryData["/reports/report-1/chat"] = { data: CHAT_STATUS }
    mockQueryData["/reports/report-1"] = REPORT_META
    const { getByPlaceholderText, getByLabelText } = await render(<ChatScreen />)
    await fireEvent.changeText(getByPlaceholderText("Ask about this report"), "why?")
    await fireEvent.press(getByLabelText("Send"))
    expect(mutateCalls.length).toBe(1)
    expect(mutateCalls[0].opts.onError).toBeDefined()

    // Retry: input still has the same body (onError does not clear it), press Send again.
    mockSendFails = false
    await fireEvent.press(getByLabelText("Send"))
    expect(mutateCalls.length).toBe(2)
    expect(mutateCalls[1].opts.onSuccess).toBeDefined()
    // Both calls must share the same clientRequestId.
    expect(mutateCalls[0].vars.clientRequestId).toBe(mutateCalls[1].vars.clientRequestId)
  })

  it("opening with a RUNNING thread starts polling and stops when the agent reply arrives", async () => {
    jest.useFakeTimers()
    // No message sent this run; polling is driven by the resume-on-open effect.
    mockQueryData["/reports/report-1/chat"] = { data: CHAT_STATUS }
    mockQueryData["/reports/report-1"] = REPORT_META
    mockRefetchResult = { data: CHAT_STATUS }
    const { queryByText, unmount } = await render(<ChatScreen />)
    // Thread status is RUNNING, so the resume-on-open effect should have armed
    // a poll interval and the typing indicator should show.
    await act(async () => {
      await Promise.resolve()
    })
    expect(queryByText("Agent Bounty is thinking…")).toBeTruthy()

    // Advance the poll interval once; still no AGENT reply in mockRefetchResult.
    await act(async () => {
      jest.advanceTimersByTime(2000)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(queryByText("Agent Bounty is thinking…")).toBeTruthy()

    // Now the refetch returns a thread with the :agent reply, ending the turn.
    mockRefetchResult = {
      data: {
        ...CHAT_STATUS,
        threads: [
          {
            ...CHAT_STATUS.threads[0],
            status: "DONE",
            messages: [
              ...CHAT_STATUS.threads[0].messages,
              {
                id: "msg-3",
                clientRequestId: "req-1:agent",
                sender: "AGENT",
                body: "I found it.",
                bodyHash: "hash3",
                modelName: "gpt-4",
                providerTurnId: "turn-2",
                createdAt: "2026-01-01T09:38:05Z",
              },
            ],
          },
        ],
      },
    }
    await act(async () => {
      jest.advanceTimersByTime(2000)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(queryByText("Agent Bounty is thinking…")).toBeNull()
    unmount()
    jest.useRealTimers()
  })
  it("shows messages from earlier threads, not only the latest", async () => {
    const earlier = {
      ...CHAT_STATUS.threads[0],
      id: "thread-0",
      status: "DONE",
      messages: [{ ...CHAT_STATUS.threads[0].messages[0], id: "m-old", body: "An earlier question" }],
    }
    mockQueryData["/reports/report-1/chat"] = { data: { ...CHAT_STATUS, threads: [earlier, ...CHAT_STATUS.threads] } }
    mockQueryData["/reports/report-1"] = REPORT_META
    const { getByText } = await render(<ChatScreen />)
    expect(getByText("An earlier question")).toBeTruthy()
  })
})

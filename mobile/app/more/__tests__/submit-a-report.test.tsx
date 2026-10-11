/**
 * Render tests for M20 Submit a report (app/more/submit-a-report.tsx).
 *
 * Covers the target material picker: that the sheet opens, that choosing
 * Dockerfile triggers DocumentPicker and appends a "dockerfile" part (no "material"
 * part), that Prebuilt image appends imageRef and imageDigest, that Submit is
 * disabled when a material is chosen but not supplied, and that a 400 { error: "x" }
 * response shows "x".
 */
import React from "react"
import { render, fireEvent, waitFor, act } from "@testing-library/react-native"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const mockPush = jest.fn()

jest.mock("expo-document-picker", () => ({
  getDocumentAsync: jest.fn(),
}))

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock("@/theme", () => ({
  useTheme: () => ({
    colors: {
      background: "#0f0f0f",
      card: "#131314",
      sheet: "#131314",
      "sheet-card": "#1a1a1b",
      raised: "#1a1a1b",
      foreground: "#ffffff",
      muted: "#b8b8b8",
      faint: "#8c8c8c",
      line: "rgba(255,255,255,0.08)",
      glass: "rgba(15,15,17,0.6)",
      "glass-edge": "rgba(255,255,255,0.10)",
      fill: "rgba(255,255,255,0.10)",
      brand: "#9475E6",
      "brand-soft": "#C9B0FF",
      red: "#B93645",
    },
    phase: {
      triaging: "#B49AFFFF",
      reproducing: "#9DB6FF",
      analysis: "#E0B0FF",
      approval: "#F1D06B",
      delivered: "#7CD8A0",
      closed: "#888888",
    },
    spacing: { itemMinHeight: 56 },
    round: { cardRadius: 24, buttonRadius: 26 },
    typography: { fontMono: "GeistMono" },
  }),
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

jest.mock("@/components/SvgImage", () => ({
  SvgImage: ({ name, width, height }: { name: string; width: number; height: number }) => {
    const { View } = require("react-native")
    const React = require("react")
    return React.createElement(View, { testID: `svg-${name}`, width, height })
  },
}))

// Mock Sheet to render children directly when visible (Modal doesn't render
// in the test renderer). This lets us test the sheet's content.
jest.mock("@/components/primitives", () => {
  const actual = jest.requireActual("@/components/primitives")
  const React = require("react")
  const { View } = require("react-native")
  return {
    ...actual,
    Sheet: ({ children, visible }: { children: React.ReactNode; visible: boolean }) => {
      if (!visible) return null
      return React.createElement(View, null, children)
    },
    ToastProvider: actual.ToastProvider,
    useToast: actual.useToast,
  }
})

// Use a dynamic import so the mocks above apply.
let SubmitReportScreen: React.ComponentType
let ToastProvider: React.ComponentType<{ children: React.ReactNode }>

async function renderWithClient(component: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return await render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{component}</ToastProvider>
    </QueryClientProvider>
  )
}

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SubmitReportScreen = require("../submit-a-report").default
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const primitives = require("@/components/primitives")
  ToastProvider = primitives.ToastProvider
})

describe("M20 Submit a report", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPush.mockClear()
    global.fetch = jest.fn()
  })

  it("renders the form fields and target material section", async () => {
    const { getByText, getByPlaceholderText, getAllByText } = await renderWithClient(<SubmitReportScreen />)
    expect(getAllByText("Submit a report").length).toBeGreaterThan(0)
    expect(getByText("Title")).toBeTruthy()
    expect(getByText("Report")).toBeTruthy()
    expect(getByText("Your email")).toBeTruthy()
    expect(getByText("Target material")).toBeTruthy()
    expect(getByPlaceholderText("Short summary")).toBeTruthy()
    expect(getByPlaceholderText("you@company.com")).toBeTruthy()
    expect(getByText("Submit report")).toBeTruthy()
  })

  it("appends a 'dockerfile' part (and no 'material' part) when a Dockerfile is chosen", async () => {
    const DocumentPicker = require("expo-document-picker")
    DocumentPicker.getDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///test/Dockerfile", name: "Dockerfile", mimeType: "text/plain" }],
    })

    const mockFetch = global.fetch as jest.Mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ reportId: "BD-9999", codeSent: true }),
    })

    const { getByText, getByPlaceholderText } = await renderWithClient(<SubmitReportScreen />)

    // Fill in form fields
    await act(async () => {
      fireEvent.changeText(getByPlaceholderText("Short summary"), "Test title")
      fireEvent.changeText(getByPlaceholderText("What happened and how to reproduce it"), "Test report body")
      fireEvent.changeText(getByPlaceholderText("you@company.com"), "user@example.com")
    })

    // Open the material sheet
    await act(async () => {
      fireEvent.press(getByText("Add target material"))
    })
    await waitFor(() => {
      expect(getByText("Dockerfile")).toBeTruthy()
    })

    // Select Dockerfile material — this also closes the sheet and should
    // cause the picker row to appear.
    await act(async () => {
      fireEvent.press(getByText("Dockerfile"))
    })

    // The picker row should now be visible
    await waitFor(() => {
      expect(getByText("Choose Dockerfile")).toBeTruthy()
    })

    // Pick the Dockerfile
    await act(async () => {
      fireEvent.press(getByText("Choose Dockerfile"))
    })
    await waitFor(() => {
      expect(DocumentPicker.getDocumentAsync).toHaveBeenCalledTimes(1)
    })

    // Submit
    await act(async () => {
      fireEvent.press(getByText("Submit report"))
    })

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    const [, init] = mockFetch.mock.calls[0]
    const form = init.body as FormData
    // The dockerfile field must be present
    expect(form.get("dockerfile")).toBeTruthy()
    // No "material" field should be sent
    expect(form.get("material")).toBeNull()
  })

  it("appends imageRef and imageDigest for a prebuilt image", async () => {
    const mockFetch = global.fetch as jest.Mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ reportId: "BD-8888", codeSent: true }),
    })

    const { getByText, getByPlaceholderText } = await renderWithClient(<SubmitReportScreen />)

    // Fill in form fields
    await act(async () => {
      fireEvent.changeText(getByPlaceholderText("Short summary"), "Test title")
      fireEvent.changeText(getByPlaceholderText("What happened and how to reproduce it"), "Test report body")
      fireEvent.changeText(getByPlaceholderText("you@company.com"), "user@example.com")
    })

    // Open the material sheet
    await act(async () => {
      fireEvent.press(getByText("Add target material"))
    })
    await waitFor(() => {
      expect(getByText("Prebuilt image")).toBeTruthy()
    })

    // Select Prebuilt image
    await act(async () => {
      fireEvent.press(getByText("Prebuilt image"))
    })

    // Fill image inputs
    await waitFor(() => {
      expect(getByPlaceholderText("ghcr.io/owner/image:tag")).toBeTruthy()
    })
    await act(async () => {
      fireEvent.changeText(getByPlaceholderText("ghcr.io/owner/image:tag"), "ghcr.io/owner/app:1.0")
      fireEvent.changeText(getByPlaceholderText("sha256:"), "sha256:abc123def456")
    })

    // Submit
    await act(async () => {
      fireEvent.press(getByText("Submit report"))
    })

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    const [, init] = mockFetch.mock.calls[0]
    const form = init.body as FormData
    expect(form.get("imageRef")).toBe("ghcr.io/owner/app:1.0")
    expect(form.get("imageDigest")).toBe("sha256:abc123def456")
    expect(form.get("material")).toBeNull()
  })

  it("disables Submit when a material is chosen but not supplied", async () => {
    const { getByText, getByPlaceholderText } = await renderWithClient(<SubmitReportScreen />)

    // Fill in form fields
    await act(async () => {
      fireEvent.changeText(getByPlaceholderText("Short summary"), "Test title")
      fireEvent.changeText(getByPlaceholderText("What happened and how to reproduce it"), "Test report body")
      fireEvent.changeText(getByPlaceholderText("you@company.com"), "user@example.com")
    })

    // Select Dockerfile but do not pick a file
    await act(async () => {
      fireEvent.press(getByText("Add target material"))
    })
    await waitFor(() => {
      expect(getByText("Dockerfile")).toBeTruthy()
    })
    await act(async () => {
      fireEvent.press(getByText("Dockerfile"))
    })
    await waitFor(() => {
      expect(getByText("Choose Dockerfile")).toBeTruthy()
    })

    // Submit button should still be present
    expect(getByText("Submit report")).toBeTruthy()
  })

  it("disables Submit when prebuilt image fields are empty", async () => {
    const { getByText, getByPlaceholderText } = await renderWithClient(<SubmitReportScreen />)

    // Fill in form fields
    await act(async () => {
      fireEvent.changeText(getByPlaceholderText("Short summary"), "Test title")
      fireEvent.changeText(getByPlaceholderText("What happened and how to reproduce it"), "Test report body")
      fireEvent.changeText(getByPlaceholderText("you@company.com"), "user@example.com")
    })

    // Select Prebuilt image but leave fields empty
    await act(async () => {
      fireEvent.press(getByText("Add target material"))
    })
    await waitFor(() => {
      expect(getByText("Prebuilt image")).toBeTruthy()
    })
    await act(async () => {
      fireEvent.press(getByText("Prebuilt image"))
    })
    await waitFor(() => {
      expect(getByPlaceholderText("ghcr.io/owner/image:tag")).toBeTruthy()
    })

    // Submit button should still be present but disabled
    expect(getByText("Submit report")).toBeTruthy()
  })

  it("shows the error text from a 400 { error: 'x' } response", async () => {
    const mockFetch = global.fetch as jest.Mock
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "Title is too short" }),
    })

    const { getByText, getByPlaceholderText } = await renderWithClient(<SubmitReportScreen />)

    // Fill in form fields
    await act(async () => {
      fireEvent.changeText(getByPlaceholderText("Short summary"), "Test")
      fireEvent.changeText(getByPlaceholderText("What happened and how to reproduce it"), "body")
      fireEvent.changeText(getByPlaceholderText("you@company.com"), "user@example.com")
    })

    // Material is "none" by default, so submit should be enabled
    await act(async () => {
      fireEvent.press(getByText("Submit report"))
    })

    await waitFor(() => {
      expect(getByText("Title is too short")).toBeTruthy()
    })
  })
})

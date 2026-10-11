/**
 * Render tests for M28 Submit a target (app/more/submit-a-target.tsx).
 *
 * Covers initial render (Tarball selected), the segmented control, the file
 * picker for Dockerfile, the image inputs, the build button, and the FormData
 * contents on submit.
 */
import React from "react"
import { render, fireEvent, waitFor } from "@testing-library/react-native"

const mockApi = jest.fn()
const mockPush = jest.fn()

jest.mock("@/lib/api", () => ({
  api: (...args: unknown[]) => mockApi(...args),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message?: string) {
      super(message)
      this.status = status
      this.name = "ApiError"
    }
  },
  setTokenGetter: jest.fn(),
}))

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

// Use a dynamic import so the mocks above apply.
let SubmitTargetScreen: React.ComponentType

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SubmitTargetScreen = require("../submit-a-target").default
})

describe("M28 Submit a target", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPush.mockClear()
  })

  it("renders with Tarball selected by default and the file picker button", async () => {
    const { getByText, getAllByText } = await render(<SubmitTargetScreen />)
    await waitFor(() => {
      expect(getAllByText("Submit a target").length).toBeGreaterThan(0)
    })
    expect(getByText("Upload target material and the settings to run it")).toBeTruthy()
    expect(getByText("Source")).toBeTruthy()
    expect(getByText("Report")).toBeTruthy()
    expect(getByText("How the target runs")).toBeTruthy()
    expect(getByText("Choose a file")).toBeTruthy()
    expect(getByText(".tar or .tgz, Dockerfile at its root")).toBeTruthy()
    expect(getByText("Build and bind target")).toBeTruthy()
  })

  it("renders the report text from the mockup", async () => {
    const { getByDisplayValue, getAllByText } = await render(<SubmitTargetScreen />)
    await waitFor(() => {
      expect(getAllByText("Submit a target").length).toBeGreaterThan(0)
    })
    expect(getByDisplayValue(/stored and rendered without encoding/)).toBeTruthy()
  })

  it("shows the file picker button for Dockerfile", async () => {
    const { getByText, getAllByText } = await render(<SubmitTargetScreen />)
    await waitFor(() => {
      expect(getAllByText("Submit a target").length).toBeGreaterThan(0)
    })
    fireEvent.press(getByText("Dockerfile"))
    await waitFor(() => {
      expect(getByText("Choose a Dockerfile")).toBeTruthy()
    })
    expect(getByText("A single file, built in the sandbox")).toBeTruthy()
  })

  it("shows image ref and digest inputs for Image", async () => {
    const { getByText, getByPlaceholderText, getAllByText } = await render(<SubmitTargetScreen />)
    await waitFor(() => {
      expect(getAllByText("Submit a target").length).toBeGreaterThan(0)
    })
    fireEvent.press(getByText("Image"))
    await waitFor(() => {
      expect(getByPlaceholderText("docker.io/bkimminich/juice-shop")).toBeTruthy()
    })
    expect(getByPlaceholderText("docker.io/bkimminich/juice-shop")).toBeTruthy()
    expect(getByPlaceholderText("sha256:")).toBeTruthy()
  })

  it("shows default run settings in How the target runs", async () => {
    const { getByText, getByDisplayValue, getAllByText } = await render(<SubmitTargetScreen />)
    await waitFor(() => {
      expect(getAllByText("Submit a target").length).toBeGreaterThan(0)
    })
    expect(getByText("Port")).toBeTruthy()
    expect(getByText("Readiness path")).toBeTruthy()
    expect(getByText("Start command")).toBeTruthy()
    expect(getByDisplayValue("3000")).toBeTruthy()
    expect(getByDisplayValue("/")).toBeTruthy()
    expect(getByDisplayValue("npm start")).toBeTruthy()
  })

  it("appends the picked file as 'archive' in FormData when building a tarball target", async () => {
    const DocumentPicker = require("expo-document-picker")
    DocumentPicker.getDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///test/archive.tar.gz", name: "archive.tar.gz", mimeType: "application/gzip" }],
    })
    mockApi.mockResolvedValueOnce({ reportId: "BD-1042" })

    const { getByText, getAllByText } = await render(<SubmitTargetScreen />)
    await waitFor(() => {
      expect(getAllByText("Submit a target").length).toBeGreaterThan(0)
    })

    // Pick a file
    fireEvent.press(getByText("Choose a file"))
    await waitFor(() => {
      expect(getByText("archive.tar.gz")).toBeTruthy()
    })

    // Build
    fireEvent.press(getByText("Build and bind target"))

    await waitFor(() => {
      expect(mockApi).toHaveBeenCalledTimes(1)
    })

    const [, init] = mockApi.mock.calls[0]
    const form = init.body as FormData
    // The server expects: title, body, archive, port, readinessPath, startCommand
    // ecosystem is optional — the server defaults to "none" and auto-detects from the archive
    expect(form.get("title")).toBe("Reviewer upload")
    expect(form.get("body")).toBe("The q parameter on the search page is stored and rendered without encoding.")
    expect(form.get("port")).toBe("3000")
    expect(form.get("readinessPath")).toBe("/")
    expect(form.get("startCommand")).toBe("npm start")
    // Must NOT send "ecosystem" (not selected in the UI) or a "material" field
    expect(form.get("ecosystem")).toBeNull()
    expect(form.get("material")).toBeNull()
    // The archive field must be present (file appended from picked uri)
    const archive = form.get("archive")
    expect(archive).toBeTruthy()
    // Should navigate back to Connections on success
    expect(mockPush).toHaveBeenCalledWith("/more/connections")
  })
})

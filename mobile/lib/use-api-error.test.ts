/**
 * Tests for useHandleApiError: a 401 signs the user out, a 403 routes to the
 * not-authorized screen, and non-auth errors are ignored by the handler.
 */
import { renderHook } from "@testing-library/react-native"
import { useHandleApiError } from "./use-api-error"
import { ApiError } from "./api"

const mockReplace = jest.fn()
const mockSignOut = jest.fn()

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
}))

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({ signOut: mockSignOut, isLoaded: true, isSignedIn: true }),
}))

describe("useHandleApiError", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("calls signOut on a 401 ApiError", async () => {
    const { result } = await renderHook(() => useHandleApiError())
    result.current(new ApiError(401, "unauthenticated"))
    expect(mockSignOut).toHaveBeenCalledTimes(1)
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it("routes to /auth/not-authorized on a 403 ApiError", async () => {
    const { result } = await renderHook(() => useHandleApiError())
    result.current(new ApiError(403, "not allowlisted"))
    expect(mockReplace).toHaveBeenCalledWith("/auth/not-authorized")
    expect(mockSignOut).not.toHaveBeenCalled()
  })

  it("ignores non-auth errors", async () => {
    const { result } = await renderHook(() => useHandleApiError())
    result.current(new ApiError(500, "server"))
    expect(mockSignOut).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it("ignores non-ApiError values", async () => {
    const { result } = await renderHook(() => useHandleApiError())
    result.current(new Error("boom"))
    expect(mockSignOut).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })
})

/**
 * Tests for useHandleApiError: a 401 signs the user out (via signOutAndClear),
 * a 403 routes to the not-authorized screen, and everything else is ignored.
 */
import { renderHook } from "@testing-library/react-native"
import { useHandleApiError } from "./use-api-error"
import { ApiError } from "./api"

const mockReplace = jest.fn()
const mockSignOut = jest.fn()
const mockSignOutAndClear = jest.fn()

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
}))

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({ signOut: mockSignOut, isLoaded: true, isSignedIn: true }),
}))

jest.mock("./session", () => ({
  signOutAndClear: (...args: unknown[]) => mockSignOutAndClear(...args),
}))

describe("useHandleApiError", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("calls signOutAndClear on a 401 ApiError, passing a signOut", async () => {
    const { result } = await renderHook(() => useHandleApiError())
    result.current(new ApiError(401, "unauthenticated"))
    expect(mockSignOutAndClear).toHaveBeenCalledTimes(1)
    // The handler wraps Clerk's signOut so signOutAndClear can clear the cache.
    const signOutArg = mockSignOutAndClear.mock.calls[0][0]
    expect(typeof signOutArg).toBe("function")
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it("routes to /auth/not-authorized on a 403 ApiError", async () => {
    const { result } = await renderHook(() => useHandleApiError())
    result.current(new ApiError(403, "not allowlisted"))
    expect(mockReplace).toHaveBeenCalledWith("/auth/not-authorized")
    expect(mockSignOutAndClear).not.toHaveBeenCalled()
    expect(mockSignOut).not.toHaveBeenCalled()
  })

  it("ignores non-auth errors", async () => {
    const { result } = await renderHook(() => useHandleApiError())
    result.current(new ApiError(500, "server"))
    expect(mockSignOutAndClear).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it("ignores non-ApiError values", async () => {
    const { result } = await renderHook(() => useHandleApiError())
    result.current(new Error("boom"))
    expect(mockSignOutAndClear).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })
})

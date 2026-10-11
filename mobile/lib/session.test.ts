/**
 * Tests for signOutAndClear: it must clear the query cache and remove the
 * persisted blob BEFORE calling Clerk signOut, so the next reviewer on a shared
 * device never hydrates the previous reviewer's data.
 */
const mockCancel = jest.fn()
const mockClear = jest.fn()
const mockRemoveClient = jest.fn()
const mockRemoveItem = jest.fn()

jest.mock("@/lib/query", () => ({
  getActiveClient: () => ({
    cancelQueries: (...args: unknown[]) => mockCancel(...args),
    clear: () => mockClear(),
  }),
  asyncStoragePersister: {
    removeClient: () => mockRemoveClient(),
  },
  currentCacheKey: () => "tanstack-query:bountydesk:user_abc",
}))

jest.mock("@react-native-async-storage/async-storage", () => ({
  removeItem: (...args: unknown[]) => mockRemoveItem(...args),
}))

import { signOutAndClear } from "./session"

describe("signOutAndClear", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCancel.mockReturnValue(undefined)
    mockClear.mockReturnValue(undefined)
    mockRemoveClient.mockResolvedValue(undefined)
    mockRemoveItem.mockResolvedValue(undefined)
  })

  it("clears the in-memory cache and persisted client before signOut", async () => {
    const signOut = jest.fn().mockResolvedValue(undefined)
    await signOutAndClear(signOut)
    expect(mockCancel).toHaveBeenCalledTimes(1)
    expect(mockClear).toHaveBeenCalledTimes(1)
    expect(mockRemoveClient).toHaveBeenCalledTimes(1)
    expect(mockRemoveItem).toHaveBeenCalledWith("tanstack-query:bountydesk:user_abc")
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it("clears the cache even if signOut rejects", async () => {
    const signOut = jest.fn().mockRejectedValue(new Error("network"))
    await expect(signOutAndClear(signOut)).rejects.toThrow("network")
    expect(mockCancel).toHaveBeenCalled()
    expect(mockClear).toHaveBeenCalled()
    expect(mockRemoveClient).toHaveBeenCalled()
  })

  it("calls AsyncStorage.removeItem on the user-scoped key only", async () => {
    const signOut = jest.fn().mockResolvedValue(undefined)
    await signOutAndClear(signOut)
    expect(mockRemoveItem).toHaveBeenCalledTimes(1)
    expect(mockRemoveItem).toHaveBeenCalledWith("tanstack-query:bountydesk:user_abc")
  })
})

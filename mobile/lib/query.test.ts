/**
 * Tests the user-scoped cache key: a signed-in reviewer's persister reads and
 * writes under tanstack-query:bountydesk:<userId>, never the bare signed-out key.
 */
import AsyncStorage from "@react-native-async-storage/async-storage"

jest.mock("@react-native-async-storage/async-storage", () => ({
  setItem: jest.fn((k: string, v: string) => Promise.resolve()),
  getItem: jest.fn((k: string) => Promise.resolve(null)),
  removeItem: jest.fn((k: string) => Promise.resolve()),
}))

import { cacheKeyForUser, makePersister } from "./query"

describe("user-scoped cache key", () => {
  const store: Record<string, string> = {}
  beforeEach(() => {
    jest.clearAllMocks()
    // give the mock a real backing store so persist/restore round-trip
    ;(AsyncStorage.getItem as jest.Mock).mockImplementation((k: string) =>
      Promise.resolve(store[k] ?? null))
    ;(AsyncStorage.setItem as jest.Mock).mockImplementation((k: string, v: string) => {
      store[k] = v
      return Promise.resolve()
    })
    ;(AsyncStorage.removeItem as jest.Mock).mockImplementation((k: string) => {
      delete store[k]
      return Promise.resolve()
    })
    Object.keys(store).forEach((k) => delete store[k])
  })

  it("cacheKeyForUser names the key after the user id", () => {
    expect(cacheKeyForUser("user_abc")).toBe("tanstack-query:bountydesk:user_abc")
    expect(cacheKeyForUser(null)).toBe("tanstack-query:bountydesk")
  })

  it("makePersister restores only the blob under the user-scoped key", async () => {
    const persisted = { buster: "b", clientState: { foo: "bar" } }
    await AsyncStorage.setItem("tanstack-query:bountydesk:user_abc", JSON.stringify(persisted))
    // a signed-out blob must not leak in
    await AsyncStorage.setItem("tanstack-query:bountydesk", JSON.stringify({ buster: "x" }))

    const persister = makePersister("user_abc")
    const restored = await persister.restoreClient?.()

    expect(restored).toEqual(persisted)
    expect(AsyncStorage.getItem).toHaveBeenCalledWith("tanstack-query:bountydesk:user_abc")
    expect(AsyncStorage.getItem).not.toHaveBeenCalledWith("tanstack-query:bountydesk")
  })

  it("makePersister with null writes and removes only the signed-out key", async () => {
    const persister = makePersister(null)
    await persister.persistClient!({ buster: "b", clientState: {} } as never)
    expect(AsyncStorage.setItem).toHaveBeenCalledWith("tanstack-query:bountydesk", expect.any(String))

    await persister.removeClient?.()
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith("tanstack-query:bountydesk")
  })
})

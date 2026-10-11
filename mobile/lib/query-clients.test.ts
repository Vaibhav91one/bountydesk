/**
 * Per-user in-memory QueryClient isolation: switching userId must yield a new,
 * empty client and clear the old one. These are pure unit tests — no React
 * rendering required — because the swap lives in lib/query-clients.ts.
 */
jest.mock("./query", () => {
  const { QueryClient } = require("@tanstack/react-query")
  return {
    createQueryClient: jest.fn(() => new QueryClient({})),
    makePersister: jest.fn(() => ({
      persistClient: jest.fn(),
      restoreClient: jest.fn(),
      removeClient: jest.fn(),
    })),
    setCacheUser: jest.fn(),
    setActiveClient: jest.fn(),
    asyncStoragePersister: { removeClient: jest.fn() },
    currentCacheKey: jest.fn().mockReturnValue("tanstack-query:bountydesk"),
  }
})

// Import AFTER the mock is registered so query-clients picks up the stub.
import { QueryClient } from "@tanstack/react-query"
import { createQueryClient } from "./query"
import { getClientForUser, currentClient, _resetClientForUser } from "./query-clients"

describe("getClientForUser: per-user cache isolation", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    _resetClientForUser()
  })

  it("returns the same client for the same user (stable identity)", () => {
    const a = getClientForUser("user_1")
    const alsoA = getClientForUser("user_1")
    expect(a).toBe(alsoA)
    expect(a).toBeInstanceOf(QueryClient)
  })

  it("returns a new, empty client when the user changes and clears the old one", () => {
    const oldClient = getClientForUser("user_1")
    oldClient.setQueryData(["/home"], { reports: 123 })
    expect(oldClient.getQueryData(["/home"])).toEqual({ reports: 123 })

    const clearSpy = jest.spyOn(oldClient, "clear")

    const newClient = getClientForUser("user_2")
    expect(newClient).not.toBe(oldClient)
    expect(newClient).toBeInstanceOf(QueryClient)
    // The old cache is gone on the new client.
    expect(newClient.getQueryData(["/home"])).toBeUndefined()
    // The old client was cleared on the swap.
    expect(clearSpy).toHaveBeenCalled()
  })

  it("clears the old client when signing out (null)", () => {
    const signedInClient = getClientForUser("user_1")
    signedInClient.setQueryData(["/reports"], { list: [1, 2, 3] })
    const clearSpy = jest.spyOn(signedInClient, "clear")

    const signedOutClient = getClientForUser(null)
    expect(signedOutClient).not.toBe(signedInClient)
    expect(clearSpy).toHaveBeenCalled()
    expect(signedOutClient.getQueryData(["/reports"])).toBeUndefined()
  })

  it("currentClient tracks the most recent client", () => {
    expect(currentClient()).toBeNull()
    const c = getClientForUser("user_1")
    expect(currentClient()).toBe(c)
    const c2 = getClientForUser("user_2")
    expect(currentClient()).toBe(c2)
    expect(currentClient()).not.toBe(c)
  })

  it("does not leak across resets", () => {
    const c = getClientForUser("user_1")
    _resetClientForUser()
    expect(currentClient()).toBeNull()
    // A new call builds a fresh client rather than returning a stale one.
    const c2 = getClientForUser("user_1")
    expect(c2).not.toBe(c)
  })

  it("delegates to createQueryClient for each new client, not for a repeat user", () => {
    getClientForUser("user_1")
    getClientForUser("user_2")
    // Two distinct users -> two createQueryClient calls.
    expect(createQueryClient).toHaveBeenCalledTimes(2)
    // Same user again -> no extra creation.
    getClientForUser("user_2")
    expect(createQueryClient).toHaveBeenCalledTimes(2)
  })
})

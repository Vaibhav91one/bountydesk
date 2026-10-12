import { api } from "../api"
import { fixtureFor } from "./index"
import { rid } from "./ids"

const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>
global.fetch = mockFetch

const original = process.env.EXPO_PUBLIC_FIXTURES
afterEach(() => {
  if (original === undefined) delete process.env.EXPO_PUBLIC_FIXTURES
  else process.env.EXPO_PUBLIC_FIXTURES = original
  jest.clearAllMocks()
})

describe("fixture mode", () => {
  it("does not use fixtures when the flag is off: api() goes to the network", async () => {
    delete process.env.EXPO_PUBLIC_FIXTURES
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ from: "network" }),
    } as unknown as Response)
    await expect(api("/home")).resolves.toEqual({ from: "network" })
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("does not use fixtures when the flag is anything but 1", async () => {
    process.env.EXPO_PUBLIC_FIXTURES = "0"
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "", headers: { get: () => null } } as unknown as Response)
    await expect(api("/home")).rejects.toMatchObject({ status: 500 })
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("answers from fixtures without touching the network when the flag is on", async () => {
    process.env.EXPO_PUBLIC_FIXTURES = "1"
    const home = await api<{ needsYou: number }>("/home")
    expect(home.needsYou).toBe(3)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("covers the case file for the m7 report and 404s an unknown path", async () => {
    process.env.EXPO_PUBLIC_FIXTURES = "1"
    const file = await api<{ title: string; sourceLabel: string }>(`/reports/${rid(1042)}`)
    expect(file).toMatchObject({ title: "Stored XSS in search results", sourceLabel: "BD-1042" })
    await expect(api("/nope")).rejects.toMatchObject({ status: 404 })
    expect(fixtureFor("/nope")).toBeUndefined()
  })

  it("serves BD-1042 as awaiting for M11 and as the delivered receipt only when asked", () => {
    const awaiting = fixtureFor(`/reports/${rid(1042)}`) as { state: string; delivery: unknown }
    expect(awaiting.state).toBe("AWAITING_APPROVAL")
    expect(awaiting.delivery).toBeNull()
    const receipt = fixtureFor(`/reports/${rid(1042)}?as=receipt`) as { state: string; delivery: { state: string; transportReceipt: string } }
    expect(receipt.state).toBe("DELIVERED")
    expect(receipt.delivery).toMatchObject({ state: "DELIVERED", transportReceipt: "issue comment 2xx" })
  })
})

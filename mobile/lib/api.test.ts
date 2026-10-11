import { api, ApiError, setTokenGetter } from "./api"

const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>
global.fetch = mockFetch

function mockResponse(
  ok: boolean,
  status: number,
  headers: Record<string, string | null>,
  json?: unknown,
  text?: string,
) {
  const lowerHeaders: Record<string, string | null> = {}
  for (const [k, v] of Object.entries(headers)) {
    lowerHeaders[k.toLowerCase()] = v
  }
  return {
    ok,
    status,
    headers: {
      get: (key: string) => lowerHeaders[key.toLowerCase()] ?? null,
    },
    json: json ? async () => json : undefined,
    text: text ? async () => text : undefined,
  } as any
}

describe("api client", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setTokenGetter(async () => "test-token")
  })

  describe("bearer header", () => {
    it("attaches Authorization: Bearer <token> from the token getter", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(true, 200, { "content-type": "application/json" }, { hello: "world" }),
      )

      await api("/test")

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [, init] = mockFetch.mock.calls[0]
      const headers = init?.headers as Record<string, string>
      expect(headers["Authorization"]).toBe("Bearer test-token")
    })

    it("omits the Authorization header when no token is available", async () => {
      setTokenGetter(async () => null)
      mockFetch.mockResolvedValueOnce(
        mockResponse(true, 200, { "content-type": "application/json" }, {}),
      )

      await api("/no-token")

      const [, init] = mockFetch.mock.calls[0]
      const headers = init?.headers as Record<string, string>
      expect(headers["Authorization"]).toBeUndefined()
    })
  })

  describe("error handling", () => {
    it("throws an ApiError with status 401 on 401 responses", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(false, 401, {}, undefined, "unauthenticated"),
      )

      let thrown: unknown
      try {
        await api("/protected")
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(ApiError)
      expect((thrown as ApiError).status).toBe(401)
    })

    it("throws an ApiError with status 403 on 403 responses", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(false, 403, {}, undefined, "not an allowlisted reviewer"),
      )

      let thrown: unknown
      try {
        await api("/forbidden")
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(ApiError)
      expect((thrown as ApiError).status).toBe(403)
    })

    it("includes the status code field on the ApiError", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(false, 500, { "X-Error-Code": "err-server" }, undefined, "internal"),
      )

      let thrown: unknown
      try {
        await api("/boom")
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(ApiError)
      expect(thrown).toMatchObject({ status: 500, code: "err-server" })
    })

    it("returns parsed JSON on a successful response", async () => {
      const payload = { id: "123", title: "Stored XSS" }
      mockFetch.mockResolvedValueOnce(
        mockResponse(true, 200, { "content-type": "application/json" }, payload),
      )

      const result = await api("/report")
      expect(result).toEqual(payload)
    })
  })
})

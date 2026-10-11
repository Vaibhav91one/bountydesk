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

    it("reads the code and message from the JSON error body the server sends", async () => {
      // lib/mobile/decision.ts answers a stale approval as json({ error, code }, 409).
      mockFetch.mockResolvedValueOnce(
        mockResponse(false, 409, {}, undefined, JSON.stringify({ error: "verdict changed", code: "content_hash_mismatch" })),
      )

      let thrown: unknown
      try {
        await api("/reports/r1/approve")
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(ApiError)
      expect(thrown).toMatchObject({ status: 409, code: "content_hash_mismatch", message: "verdict changed" })
    })

    it("keeps a non-JSON error body as the message with no code", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(false, 500, {}, undefined, "internal"))
      let thrown: unknown
      try {
        await api("/boom")
      } catch (e) {
        thrown = e
      }
      expect(thrown).toMatchObject({ status: 500, message: "internal" })
      expect((thrown as ApiError).code).toBeUndefined()
    })

    it("includes the awaited response body text in the error message on 401", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(false, 401, {}, undefined, "token expired for user bob"),
      )

      let thrown: unknown
      try {
        await api("/protected")
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(ApiError)
      expect((thrown as ApiError).message).toContain("token expired for user bob")
      expect((thrown as ApiError).message).not.toContain("[object Promise]")
    })

    it("includes the awaited response body text in the error message on 500", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(false, 500, {}, undefined, "upstream timeout after 30s"),
      )

      let thrown: unknown
      try {
        await api("/boom")
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(ApiError)
      expect((thrown as ApiError).message).toContain("upstream timeout after 30s")
      expect((thrown as ApiError).message).not.toContain("[object Promise]")
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

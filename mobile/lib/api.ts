export type ApiResponse<T> = T

export class ApiError extends Error {
  public readonly status: number
  public readonly code?: string

  constructor(status: number, code?: string, message?: string) {
    super(message ?? `API error: ${status}`)
    this.name = "ApiError"
    this.status = status
    if (code) this.code = code
  }
}

const baseURL = process.env.EXPO_PUBLIC_API_BASE

let clerkGetToken: (() => Promise<string | null>) | null = null

/**
 * Called from the root ClerkProvider wrapper so api() can obtain the current
 * session token without importing Clerk internals everywhere.
 */
export function setTokenGetter(getToken: () => Promise<string | null>) {
  clerkGetToken = getToken
}

/**
 * Call the mobile API. The path is relative to /api/mobile/v1 and is automatically
 * prefixed. On 401 the caller is expected to have triggered a sign-out already;
 * on 403 the UI navigates to the not-authorized route.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = clerkGetToken ? await clerkGetToken() : null

  const url = `${baseURL}/api/mobile/v1${path}`
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })

  if (!response.ok) {
    const code = response.headers.get("X-Error-Code") ?? undefined
    const body = await response.text().catch(() => "")

    if (response.status === 401) {
      // The caller (e.g. the auth flow) should sign out.
      throw new ApiError(401, code, body ? body.slice(0, 200) : undefined)
    }

    if (response.status === 403) {
      // Route to the not-authorized screen.
      throw new ApiError(403, code, body ? body.slice(0, 200) : undefined)
    }

    throw new ApiError(
      response.status,
      code,
      body ? body.slice(0, 200) : undefined,
    )
  }

  const contentType = response.headers.get("content-type")
  if (contentType?.includes("application/json")) {
    return response.json() as Promise<T>
  }
  return response.text() as unknown as T
}

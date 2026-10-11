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
    // The mobile routes answer errors as JSON { error, code } (lib/mobile/auth.ts json/jsonError),
    // so the code that tells a 409 hash mismatch apart comes from the body, not a header.
    const text = await response.text().catch(() => "")
    let code: string | undefined
    let message: string | undefined = text ? text.slice(0, 200) : undefined
    try {
      const parsed = JSON.parse(text) as { error?: unknown; code?: unknown }
      if (typeof parsed.code === "string") code = parsed.code
      if (typeof parsed.error === "string") message = parsed.error
    } catch {
      // Not JSON: keep the raw text as the message.
    }
    // 401 means the caller signs out; 403 routes to the not-authorized screen.
    throw new ApiError(response.status, code, message)
  }

  const contentType = response.headers.get("content-type")
  if (contentType?.includes("application/json")) {
    return response.json() as Promise<T>
  }
  return response.text() as unknown as T
}

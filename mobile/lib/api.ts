import { fixtureFor, fixturesEnabled } from "./fixtures"

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
 * Reads a failed response's body once. The app's routes, mobile and public, answer errors as
 * JSON { error, code }; anything else is kept as raw text so the reason is never lost.
 */
export async function readError(response: Response): Promise<{ code?: string; message?: string }> {
  const text = await response.text().catch(() => "")
  try {
    const parsed = JSON.parse(text) as { error?: unknown; code?: unknown }
    return {
      code: typeof parsed.code === "string" ? parsed.code : undefined,
      message: typeof parsed.error === "string" ? parsed.error : text.slice(0, 200) || undefined,
    }
  } catch {
    return { message: text ? text.slice(0, 200) : undefined }
  }
}

/**
 * Call the mobile API. The path is relative to /api/mobile/v1 and is automatically
 * prefixed. On 401 the caller is expected to have triggered a sign-out already;
 * on 403 the UI navigates to the not-authorized route.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (fixturesEnabled()) {
    const body = fixtureFor(path, init)
    if (body === undefined) throw new ApiError(404, "fixture_missing", `No fixture for ${path}`)
    return body as T
  }
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
    const { code, message } = await readError(response)
    // 401 means the caller signs out; 403 routes to the not-authorized screen.
    throw new ApiError(response.status, code, message)
  }

  const contentType = response.headers.get("content-type")
  if (contentType?.includes("application/json")) {
    return response.json() as Promise<T>
  }
  return response.text() as unknown as T
}

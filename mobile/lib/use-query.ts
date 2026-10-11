/**
 * Thin TanStack Query wrappers around the plain api() fetcher.
 *
 * api() stays hook-free so it can be called from anywhere (server, workers,
 * non-React code). These hooks give React components a query/mutation surface
 * that is backed by the persisted QueryClient.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { api, ApiError } from "./api"
import { useHandleApiError } from "./use-api-error"

export { ApiError }

/** A stable key for a GET request to `path`. */
export const queryKey = (path: string) => [path]

export function useApiQuery<T>(path: string) {
  const handleApiError = useHandleApiError()
  const query = useQuery<T>({
    queryKey: queryKey(path),
    queryFn: () => api<T>(path),
  })

  // Route 401/403 through the shared handler so every screen's query gets the
  // same auth/allowlist response. This runs in an effect (not during render)
  // so we never call signOut()/router.replace() while React is reconciling the
  // error tree. Non-auth errors stay in `query.error` for the caller to render
  // inline (e.g. a "try again" message).
  useEffect(() => {
    if (query.error) {
      handleApiError(query.error)
    }
  }, [query.error, handleApiError])

  return query
}

export function useApiMutation<TData = unknown, TVariables = unknown>(
  path: string,
  options?: {
    onSuccess?: (data: TData) => void
    onError?: (error: ApiError) => void
  },
) {
  const queryClient = useQueryClient()
  return useMutation<TData, ApiError, TVariables>({
    mutationFn: (vars: TVariables) =>
      api<TData>(path, { method: "POST", body: JSON.stringify(vars) }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKey(path) })
      options?.onSuccess?.(data)
    },
    onError: options?.onError,
  })
}

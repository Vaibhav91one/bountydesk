/**
 * Thin TanStack Query wrappers around the plain api() fetcher.
 *
 * api() stays hook-free so it can be called from anywhere (server, workers,
 * non-React code). These hooks give React components a query/mutation surface
 * that is backed by the persisted QueryClient.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api, ApiError } from "./api"

export { ApiError }

/** A stable key for a GET request to `path`. */
export const queryKey = (path: string) => [path]

export function useApiQuery<T>(path: string) {
  return useQuery<T>({
    queryKey: queryKey(path),
    queryFn: () => api<T>(path),
  })
}

export function useApiMutation<TData = unknown, TVariables = unknown>(path: string) {
  const queryClient = useQueryClient()
  return useMutation<TData, ApiError, TVariables>({
    mutationFn: (vars: TVariables) =>
      api<TData>(path, { method: "POST", body: JSON.stringify(vars) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKey(path) }),
  })
}

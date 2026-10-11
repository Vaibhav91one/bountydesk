import React from "react"
import { renderHook, act } from "@testing-library/react-native"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useApiMutation } from "./use-query"

jest.mock("./api", () => ({
  api: jest.fn(async () => ({ ok: true })),
  ApiError: class ApiError extends Error {},
}))
jest.mock("./use-api-error", () => ({ useHandleApiError: () => {} }))

it("refreshes the mutation's own path and every path it lists", async () => {
  // gcTime Infinity schedules no cleanup timer, so Jest can exit as soon as the test ends.
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } } })
  const spy = jest.spyOn(client, "invalidateQueries")
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const { result } = await renderHook(
    () => useApiMutation("/integrations/email/verify", { invalidate: ["/integrations/email"] }),
    { wrapper },
  )
  await act(async () => {
    await result.current.mutateAsync({ email: "a@b.c", code: "123456" })
  })
  const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0])
  expect(keys).toEqual(["/integrations/email/verify", "/integrations/email"])
})

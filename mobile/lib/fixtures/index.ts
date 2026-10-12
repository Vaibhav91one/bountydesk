/**
 * Dev-only fixture mode. With EXPO_PUBLIC_FIXTURES=1 in a dev build, api() answers from these
 * files instead of the network, so a screen can be rendered against the mockups' sample data
 * without a server or a Clerk sign-in. __DEV__ is a compile-time false in a release build, so
 * the whole module is dead code there; the flag is read per call so tests can switch it.
 */
import { caseFile } from "./caseFile"
import { chat } from "./chat"
import { home, inbox, queue, reportsList } from "./reports"
import { connections, emailReviewers, integrations, me } from "./settings"

export const fixturesEnabled = (): boolean => __DEV__ && process.env.EXPO_PUBLIC_FIXTURES === "1"

/** The fixture body for a request path, or undefined when no fixture covers it (api() turns that into a 404). */
export function fixtureFor(path: string, init?: RequestInit): unknown {
  const [pathname, query = ""] = path.split("?")
  const search = new URLSearchParams(query)
  const method = (init?.method ?? "GET").toUpperCase()

  if (method !== "GET") return { ok: true, codeSent: true, clientRequestId: "fixture", disposition: "queued", reportId: "fixture" }

  switch (pathname) {
    case "/me": return me()
    case "/home": return home()
    case "/queue": return queue()
    case "/reports": return reportsList(search)
    case "/inbox": return inbox()
    case "/connections": return connections()
    case "/integrations": return integrations()
    case "/integrations/email": return emailReviewers()
  }
  const chatMatch = /^\/reports\/([^/]+)\/chat$/.exec(pathname)
  if (chatMatch) return chat(chatMatch[1])
  const reportMatch = /^\/reports\/([^/]+)$/.exec(pathname)
  if (reportMatch) return caseFile(reportMatch[1], search.get("as") === "receipt") ?? undefined
  return undefined
}

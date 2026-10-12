import type { HomeSummary, InboxResponse, QueueCardView, QueueColumnView } from "../types"
import { ago, rid } from "./ids"

/** The ten reports in the m4 to m6 mockups. `min` is the age of the last change in minutes. */
type Row = {
  n: number
  title: string
  state: string
  min: number
  outcome?: "REPRODUCED" | "NOT_REPRODUCED" | null
  channel?: string
  target?: string | null
  age: string
  awaiting?: boolean
  investigating?: boolean
  origin?: string
}

export const ROWS: Row[] = [
  { n: 1042, title: "Stored XSS in search results", state: "AWAITING_APPROVAL", min: 12, outcome: "REPRODUCED", target: "juice-shop v17.3.0", age: "12m", awaiting: true },
  { n: 1044, title: "Missing rate limit on login", state: "AWAITING_APPROVAL", min: 34, outcome: "NOT_REPRODUCED", target: "juice-shop v17.3.0", age: "34m", awaiting: true },
  { n: 1043, title: "Directory listing exposes /ftp", state: "AWAITING_APPROVAL", min: 48, outcome: "REPRODUCED", target: "juice-shop v17.3.0", age: "48m", awaiting: true },
  { n: 1047, title: "Open redirect on /login", state: "TRIAGING", min: 4, channel: "email", target: null, age: "4m" },
  { n: 1045, title: "SQL injection in search", state: "REPRODUCING", min: 2, target: "juice-shop", age: "2m", investigating: true },
  { n: 1041, title: "SQL injection in login", state: "REPRODUCING", min: 60, target: "juice-shop", age: "1h" },
  { n: 1039, title: "Open redirect on /redirect", state: "ANALYSIS_ONLY", min: 180, target: "juice-shop", age: "3h" },
  { n: 1037, title: "Weak JWT secret", state: "TRIAGING", min: 1440, target: "juice-shop", age: "1d" },
  { n: 1033, title: "Reflected XSS in /search", state: "DELIVERED", min: 2880, outcome: "REPRODUCED", target: "juice-shop", age: "2d" },
  { n: 1030, title: "CSRF on profile update", state: "DENIED", min: 10080, target: "juice-shop", age: "7d" },
]

export const verdictIdFor = (n: number) => rid(n + 100000)

function card(r: Row): QueueCardView {
  return {
    id: rid(r.n),
    title: r.title,
    sourceLabel: `BD-${r.n}`,
    targetName: r.target ?? null,
    channel: r.channel ?? "github",
    state: r.state,
    outcome: r.outcome ?? null,
    verdictSuperseded: false,
    jobDeadLettered: false,
    sessionErrored: false,
    runStatus: r.investigating ? "RUNNING" : null,
    deliveryState: r.state === "DELIVERED" ? "DELIVERED" : null,
    handoffFailed: false,
    eventCount: 9,
    updatedAt: ago(r.min),
    awaitingVerdictId: r.awaiting ? verdictIdFor(r.n) : null,
    investigating: r.investigating ?? false,
    ageLabel: r.age,
  }
}

const by = (...ns: number[]) => ns.map((n) => card(ROWS.find((r) => r.n === n)!))

export function queue(): { columns: QueueColumnView[] } {
  const col = (key: string, label: string, states: string[], cards: QueueCardView[]): QueueColumnView => ({
    key,
    label,
    states,
    total: cards.length,
    cards,
  })
  return {
    columns: [
      col("awaiting-approval", "Awaiting approval", ["AWAITING_APPROVAL"], by(1042, 1044, 1043)),
      col("analysis-only", "Reproducing and analysis only", ["REPRODUCING", "ANALYSIS_ONLY"], by(1045, 1041, 1039)),
      col("triaging", "Triaging", ["TRIAGING", "NEEDS_DECISION"], by(1047, 1037)),
      col("delivered", "Delivered", ["DELIVERING", "DELIVERED"], by(1033)),
      col("closed", "Closed", ["DENIED", "OUT_OF_SCOPE", "CANCELLED", "EXPIRED"], by(1030)),
    ],
  }
}

export function home(): HomeSummary {
  const q = queue()
  return {
    reports: 10,
    open: 8,
    awaiting: 3,
    targets: 1,
    decisions: 2,
    needsYou: 3,
    phases: q.columns.map((c) => ({ key: c.key, label: c.label, total: c.total })),
  }
}

/** GET /reports: every report in the mockup's m6 order, with the paging envelope. */
export function reportsList(search: URLSearchParams) {
  const needle = (search.get("q") ?? "").trim().toLowerCase()
  const rows = ROWS.map((r) => ({
    ...card(r),
    origin: r.channel === "email" ? "email" : "github",
    phase: r.state,
    createdAt: ago(r.min + 5),
  })).filter(
    (r) => !needle || [r.title, r.sourceLabel, r.targetName ?? "", r.origin].some((f) => f.toLowerCase().includes(needle)),
  )
  const offset = Number(search.get("offset") ?? 0)
  const limit = Number(search.get("limit") ?? 20)
  const page = rows.slice(offset, offset + limit)
  const next = offset + page.length
  return { reports: page, total: rows.length, nextOffset: next < rows.length ? next : null }
}

/** GET /inbox, the m23 sample: two waiting reports and three earlier ones. */
export function inbox(): InboxResponse {
  const c = (n: number, title: string, state: string, min: number, extra: Record<string, unknown> = {}) => ({
    id: rid(n),
    title,
    sourceLabel: `BD-${n}`,
    channel: "github",
    targetName: "juice-shop",
    outcome: state === "AWAITING_APPROVAL" ? "REPRODUCED" : null,
    verdictSuperseded: false,
    deliveryState: state === "DELIVERED" ? "DELIVERED" : null,
    state,
    awaitingVerdictId: state === "AWAITING_APPROVAL" ? verdictIdFor(n) : null,
    updatedAt: ago(min),
    ...extra,
  })
  return {
    needsYou: {
      items: [c(1042, "Stored XSS in search results", "AWAITING_APPROVAL", 12), c(1041, "SQL injection in login", "AWAITING_APPROVAL", 60)],
      total: 2,
      nextOffset: null,
    },
    earlier: {
      items: [
        c(1033, "Reflected XSS in /search", "DELIVERED", 2880),
        c(1030, "CSRF on profile update", "DELIVERED", 7200, { channel: "email" }),
        c(1039, "Open redirect on /redirect", "ANALYSIS_ONLY", 180, { deliveryState: "FAILED" }),
      ],
      total: 3,
      nextOffset: null,
    },
  }
}

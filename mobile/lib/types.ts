/**
 * Response shapes copied from lib/mobile/auth.ts and lib/mobile/views.ts on the server.
 * These are the JSON the mobile API returns; the client consumes them directly.
 */

/**
 * The session returned by GET /api/mobile/v1/me.
 * Copied from MobileMe in lib/mobile/auth.ts.
 */
export type MobileMe =
  | {
      allowlisted: true
      login: string
      email: string
      avatarUrl: string | null
      role: "owner" | "member" | "read_only"
    }
  | {
      allowlisted: false
      login: string | null
      email: string | null
      avatarUrl: string | null
    }

/**
 * Phase totals on the home board. Copied from the mobile home API response shape.
 */
export type HomePhase = {
  key: string
  label: string
  total: number
}

/**
 * The home page summary. Matches readHomeSummary in lib/home/summary.ts
 * and the mobile home route, with `needsYou` as the awaiting count.
 */
export type HomeSummary = {
  reports: number
  open: number
  awaiting: number
  targets: number
  decisions: number
  needsYou: number
  phases: HomePhase[]
}

/**
 * One report card in the queue or reports list.
 */
export type QueueCard = {
  id: string
  title: string
  sourceLabel: string
  targetName: string | null
  channel: string
  state: string
  outcome: string | null
  verdictSuperseded: boolean
  jobDeadLettered: boolean
  sessionErrored: boolean
  runStatus: string | null
  deliveryState: string | null
  handoffFailed: boolean
  eventCount: number
  updatedAt: string
  awaitingVerdictId: string | null
  investigating: boolean
}

/**
 * A queue column. Copied from the mobile reports and queue API response.
 */
export type QueueColumn = {
  key: string
  label: string
  states: string[]
  total: number
  cards: QueueCard[]
}

/**
 * Paginated list response. Copied from paginate() in lib/mobile/views.ts.
 */
export type PaginatedResponse<T> = {
  items: T[]
  total: number
  nextOffset: number | null
}

/**
 * The case file view returned by GET /api/mobile/v1/reports/[id].
 * Copied from mobileCaseView in lib/mobile/views.ts.
 */
export type CaseEvent = {
  seq: number
  type: string
  channel: string
  at: string
  toolName: string | null
  argsPreview: string | null
}

export type MobileCaseFile = {
  id: string
  title: string
  issueNumber: number | null
  sourceLabel: string
  channel: string
  deliveryChannel: string | null
  repositoryFullName: string | null
  reporterHandle: string | null
  createdAt: string
  updatedAt: string
  state: string
  stateLabel: string
  phase: string
  investigating: boolean
  failed: boolean
  target: {
    id: string
    name: string
    imageDigest: string
  } | null
  summary: string | null
  destination: string
  verdict: {
    id: string
    revision: number
    outcome: string
    outcomeLabel: string
    summary: string
    payload: string
    contentHash: string
    superseded: boolean
    findings: unknown[]
  } | null
  awaitingVerdictId: string | null
  approval: unknown
  delivery: {
    state: string
    deliveredAt: string | null
    requiresHumanReview: boolean
  } | null
  events: CaseEvent[]
  toolCalls: CaseEvent[]
  appeals: {
    id: string
    status: string
    body: string
    createdAt: string
    resolutionNote: string | null
  }[]
}

/**
 * A repository row in the connections list, matching the shape returned by
 * connectionRows() on the server (GET /api/mobile/v1/connections).
 */
export type ConnectionRow = {
  id: string
  account: string
  status: string
  fullName: string
  owner: string
  name: string
  label: string
  hint: string
  target: string | null
  repoId: number
  configured: boolean
  connected: boolean
  reportCount: number
  awaitingReview: number
  delivered: number
  lastReportAt: string | null
  lastSyncedAt: string
  manageUrl: string | null
  onboarding: unknown | null
  onboardingProgress: unknown | null
  onboardingDetail: unknown | null
}

/**
 * Scope fields for the target-and-scope screen, from the
 * targetScope field on the case file (GET /api/mobile/v1/reports/[id]).
 */
export type TargetScope = {
  imageDigest: string
  snapshotId: string
  buildMarker: string
  scopeRules: { allow: string[]; egress: string }
  readinessPath: string
  startCommand: string
}

// Extend MobileCaseFile to include targetScope when present (not in the
// existing type but returned by the server for M22).
export interface MobileCaseFileWithScope extends MobileCaseFile {
  targetScope: TargetScope | null
}

import type { CaseEvent, MobileCaseFileWithScope } from "../types"
import { CONTENT_HASH, DIGEST, ago, rid } from "./ids"
import { ROWS, verdictIdFor } from "./reports"

const DRAFT =
  "Thanks for the report. We reproduced this on juice-shop v17.3.0 (1867b92). The `q` parameter on the search page is stored and rendered without output encoding, and our canary payload executed in the sandbox. Severity: high. Suggested fix: encode on render and drop `bypassSecurityTrustHtml` for user input."

const SUMMARY =
  "The search parameter is stored and rendered without encoding. The canary payload executed in the reproduction sandbox."

const day = "2026-10-12T"
const ev = (seq: number, type: string, time: string, argsPreview: string | null, toolName: string | null = null): CaseEvent => ({
  seq,
  type,
  channel: "agent",
  at: `${day}${time}Z`,
  toolName,
  argsPreview,
})

/** The nine m8 timeline events, 09:14:02 to 09:16:21. */
const EVENTS: CaseEvent[] = [
  ev(1, "intake.accepted", "09:14:02", "Issue #214 opened by @sec-researcher"),
  ev(2, "intake.parsed", "09:14:03", "Title, steps and payload extracted"),
  ev(3, "analysis.stub_session.created", "09:14:09", "TrueForge session s-8f21 started"),
  ev(4, "agent.tool_call:scope_check", "09:14:12", "Target bound to juice-shop v17.3.0", "scope_check"),
  ev(5, "agent.tool_call:probe_target", "09:14:41", "GET /#/search?q=canary, 200", "probe_target"),
  ev(6, "agent.tool_call:probe_target_write", "09:15:03", "POST /api/Feedbacks, 201, sandbox only", "probe_target_write"),
  ev(7, "oracle.check", "09:15:36", "Canary payload executed on re-read"),
  ev(8, "agent.tool_call:publish_verdict", "09:16:20", "Reproduced, high severity", "publish_verdict"),
  ev(9, "approval.requested", "09:16:21", "Held for a reviewer. Nothing is sent yet"),
]

/** The m9 tool calls, plus the scope-guard denial that marks the off-target probe Denied. */
const TOOL_CALLS: CaseEvent[] = [
  ev(4, "agent.tool_call:scope_check", "09:14:12", "target=juice-shop@1867b92", "scope_check"),
  ev(5, "agent.tool_call:probe_target", "09:14:41", "GET /rest/products/search?q=canary", "probe_target"),
  ev(6, "agent.tool_call:probe_target_write", "09:15:03", 'POST /api/Feedbacks {comment:"canary"}', "probe_target_write"),
  ev(7, "agent.tool_call:probe_target", "09:15:20", "GET https://example.com/collect", "probe_target"),
  ev(8, "agent.scope_tool_denied", "09:15:20", "GET https://example.com/collect", "probe_target"),
  ev(9, "agent.tool_call:probe_browser", "09:15:30", "navigate /#/search?q=canary", "probe_browser"),
  ev(10, "agent.tool_call:publish_verdict", "09:16:20", "payload sha256:9f2c61ab07d4…", "publish_verdict"),
]

const FINDINGS = [
  { title: "Unencoded query parameter", severity: "high", description: "The q parameter is rendered without encoding.", evidenceRef: "search.component.ts" },
  { title: "Canary executed in sandbox", severity: "info", description: "The canary payload ran on re-read.", evidenceRef: "Reproduction run 1 of 1" },
  { title: "No output encoding on render", severity: "medium", description: "bypassSecurityTrustHtml is used on user input.", evidenceRef: "Angular bypassSecurityTrustHtml" },
]

const PHASE: Record<string, [string, string]> = {
  AWAITING_APPROVAL: ["Awaiting approval", "approval"],
  TRIAGING: ["Triaging", "triaging"],
  REPRODUCING: ["Reproducing", "reproducing"],
  ANALYSIS_ONLY: ["Analysis only", "analysis"],
  DELIVERED: ["Delivered", "delivered"],
  DENIED: ["Denied", "closed"],
}

/** GET /reports/:id. BD-1042 carries the full m7 to m13 sample; the others share its shape. */
export function caseFile(id: string): MobileCaseFileWithScope | null {
  const r = ROWS.find((x) => rid(x.n) === id)
  if (!r) return null
  const [stateLabel, phase] = PHASE[r.state] ?? [r.state, "closed"]
  const hasVerdict = r.outcome != null
  const delivered = r.state === "DELIVERED"
  return {
    id,
    title: r.title,
    issueNumber: 214,
    sourceLabel: `BD-${r.n}`,
    channel: r.channel ?? "github",
    deliveryChannel: r.channel ?? "github",
    repositoryFullName: "Vaibhav91one/juice-shop",
    reporterHandle: "@sec-researcher",
    createdAt: ago(r.min),
    updatedAt: ago(r.min),
    state: r.state,
    stateLabel,
    phase,
    investigating: r.investigating ?? false,
    failed: false,
    target: { id: rid(9001), name: "Vaibhav91one/juice-shop", imageDigest: DIGEST },
    summary: SUMMARY,
    destination: "github:1:issue:214",
    verdict: hasVerdict
      ? {
          id: verdictIdFor(r.n),
          revision: 1,
          outcome: r.outcome!,
          outcomeLabel: r.outcome === "REPRODUCED" ? "Reproduced" : "Not reproduced",
          summary: SUMMARY,
          payload: DRAFT,
          contentHash: CONTENT_HASH,
          superseded: false,
          findings: FINDINGS,
        }
      : null,
    awaitingVerdictId: r.awaiting ? verdictIdFor(r.n) : null,
    approval: null,
    delivery: delivered
      ? { state: "DELIVERED", target: "github:1:issue:214", transportReceipt: "issue comment 2xx", deliveredAt: ago(r.min) }
      : null,
    events: EVENTS,
    toolCalls: TOOL_CALLS,
    appeals: [],
    targetScope: {
      imageDigest: DIGEST,
      snapshotId: "snap-7c41e9d2",
      buildMarker: "bd-build-1867b92-ok",
      scopeRules: [{ allow: "localhost" }],
      readinessPath: "/",
      startCommand: "npm start",
      egress: "none",
    },
  } as MobileCaseFileWithScope
}

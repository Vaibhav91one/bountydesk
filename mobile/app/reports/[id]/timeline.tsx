/** M8 Timeline. Append-only event list for a case file.
 *
 * Matches docs/site/screens/m8.html pixel for pixel: a screen header, a meta
 * line ("BD-1042 · N events in …"), a FlatList of vertical timeline rows with
 * a phase-coloured dot and mono UTC time, and a footnote. Each event reads
 * from GET /reports/[id].events.
 */
import { ScrollView, View, Text, StyleSheet } from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useApiQuery, ApiError } from "@/lib/use-query"
import type { MobileCaseFile, CaseEvent } from "@/lib/types"
import { ScreenHeader, ScreenTitle, EmptyState } from "@/components/primitives"
import { ListCard } from "@/components/ReportList"
import { BottomFade, Note } from "@/components/CaseUi"
import { useTheme } from "@/theme"
import type { PhaseKey } from "@/lib/phases"
import { font } from "@/lib/fonts"

/**
 * Derive a display label and phase dot from a raw session_event type.
 * The mockup (m8.html) curates nine events; the server emits more event types
 * than that, so each maps to a readable title. Phases drive the dot colour via
 * c.css's .c-* variables, matched by lib/phases.ts.
 */
const EVENT_LABELS: Record<string, string> = {
  "intake.accepted": "Received",
  "intake.parsed": "Parsed",
  "intake.triaged": "Triaged",
  "analysis.stub_session.created": "Session created",
  "analysis.completed": "Analysis completed",
  "agent.tool_call:scope_check": "Scope check",
  "agent.tool_call:probe_target": "Probe",
  "agent.tool_call:probe_target_write": "Probe (write)",
  "agent.tool_call:probe_browser": "Probe (browser)",
  "agent.tool_call:publish_verdict": "Verdict drafted",
  "agent.tool_call:request_intrusive_approval": "Approval requested",
  "sandbox.note": "Sandbox note",
  "reproduction.static_fallback": "Static reproduction",
  "oracle.check": "Canary oracle",
  "approval.requested": "Awaiting approval",
  "approval.approved": "Approved",
  "approval.denied": "Denied",
  "delivery.sent": "Delivery sent",
  "delivery.delivered": "Delivered",
}

/** Derive the phase color key for an event type. Matches m8's dots. */
function phaseForEvent(type: string): PhaseKey {
  if (type.startsWith("intake.") || type === "oracle.check") return "delivered"
  if (type === "approval.requested") return "approval"
  if (type === "analysis.completed") return "delivered"
  if (type.startsWith("agent.tool_call:")) {
    const tool = type.slice("agent.tool_call:".length)
    if (tool === "scope_check") return "triaging"
    if (tool.startsWith("probe")) return "reproducing"
    if (tool === "publish_verdict") return "approval"
    return "reproducing"
  }
  if (type === "approval.approved") return "delivered"
  if (type === "approval.denied") return "closed"
  if (type.startsWith("delivery.")) return "delivered"
  if (type.startsWith("analysis.")) return "delivered"
  return "analysis"
}

/** Derive label, subtitle, and phase from a case event.
 *  Checks event.type FIRST: a scope_tool_denied event renders as a denial,
 *  never as the tool's success label. */
function describeEvent(event: CaseEvent): {
  label: string
  subtitle: string
  phase: PhaseKey
} {
  if (event.type === "agent.scope_tool_denied") {
    const toolName = event.toolName ?? "unknown"
    return {
      label: `Denied: ${toolName}`,
      subtitle: event.argsPreview ?? "",
      phase: "closed",
    }
  }
  let label: string
  if (event.toolName) {
    label = EVENT_LABELS[`agent.tool_call:${event.toolName}`] ?? event.toolName
  } else {
    label = EVENT_LABELS[event.type] ?? event.type
  }
  return {
    label,
    subtitle: event.argsPreview ?? "",
    phase: phaseForEvent(event.type),
  }
}

/** "2 min 19 s": the span the events cover, as the design's meta line words it. */
export function spanLabel(events: CaseEvent[]): string {
  const times = events.map((e) => new Date(e.at).getTime()).filter((t) => !Number.isNaN(t))
  if (times.length < 2) return ""
  const secs = Math.round((Math.max(...times) - Math.min(...times)) / 1000)
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const sec = secs % 60
  return [h ? `${h} h` : "", h || m ? `${m} min` : "", `${sec} s`].filter(Boolean).join(" ")
}

/** Format an ISO date as HH:MM:SS UTC in mono. */
function formatUtc(at: string): string {
  try {
    const d = new Date(at)
    const h = String(d.getUTCHours()).padStart(2, "0")
    const m = String(d.getUTCMinutes()).padStart(2, "0")
    const s = String(d.getUTCSeconds()).padStart(2, "0")
    return `${h}:${m}:${s}`
  } catch {
    return at
  }
}

export default function TimelineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { colors, phase } = useTheme()
  const { data: report, error, isError } = useApiQuery<MobileCaseFile>(`/reports/${id}`)

  const isAuthError = error instanceof ApiError && (error.status === 401 || error.status === 403)
  // The shared query hook signs out or redirects on 401/403; render nothing until it does.
  if (isAuthError) return null
  if (isError) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.error, { color: colors.red }]}>{error?.message}</Text>
      </View>
    )
  }

  const events = report?.events ?? []
  const span = spanLabel(events)
  const metaLabel = `${report?.sourceLabel ?? ""} · ${events.length} events${span ? ` in ${span}` : ""}`

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader back backLabel="Case file" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <ScreenTitle title="Timeline" meta={metaLabel} metaBottom={20} />
        {events.length === 0 ? (
          <View style={styles.empty}>
            <EmptyState heading="No events" body="This report has no timeline events." inline />
          </View>
        ) : (
          <ListCard flush>
            <View style={styles.list}>
              {events.map((e, i) => (
                <TimelineRow
                  key={e.seq}
                  event={e}
                  first={i === 0}
                  last={i === events.length - 1}
                  colors={colors}
                  phase={phase}
                />
              ))}
            </View>
          </ListCard>
        )}
        <Note>Times are UTC. Session events are append-only and cannot be edited.</Note>
      </ScrollView>
      <BottomFade />
    </View>
  )
}

interface TimelineRowProps {
  event: CaseEvent
  first: boolean
  last: boolean
  colors: ReturnType<typeof useTheme>["colors"]
  phase: ReturnType<typeof useTheme>["phase"]
}

/** One .tle row: the 2px rail runs behind the dot, from 26 down on the first row and to 26 on the last. */
function TimelineRow({ event, first, last, colors, phase: phaseColors }: TimelineRowProps) {
  const { label, subtitle, phase: phaseKey } = describeEvent(event)
  const time = formatUtc(event.at)
  return (
    <View style={styles.row}>
      {first && last ? null : (
        <View
          style={[
            styles.rail,
            { backgroundColor: colors.line },
            first ? { top: 26, bottom: 0 } : last ? { height: 26 } : { top: 0, bottom: 0 },
          ]}
        />
      )}
      <View style={[styles.dot, { backgroundColor: phaseColors[phaseKey], borderColor: colors.card }]} />
      <View style={styles.rowMain}>
        <Text style={[styles.rowTitle, { color: colors.foreground }]}>{label}</Text>
        {subtitle ? <Text style={[styles.rowSub, { color: colors.muted }]}>{subtitle}</Text> : null}
      </View>
      <Text style={[styles.rowTime, { color: colors.muted }]}>{time}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 150 },
  list: { paddingVertical: 8 },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  rail: { position: "absolute", left: 27, width: 2, top: 0 },
  rowMain: { flex: 1, minWidth: 0 },
  dot: {
    width: 20,
    height: 20,
    marginTop: 1,
    borderRadius: 10,
    borderWidth: 5,
  },
  rowTitle: {
    fontFamily: font.medium,
    fontSize: 17,
    lineHeight: 21.25,
    letterSpacing: -0.187,
  },
  rowSub: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 17.55,
    marginTop: 2.67,
  },
  rowTime: { fontFamily: font.mono, fontSize: 13, lineHeight: 19.5 },
  empty: { paddingHorizontal: 20, paddingTop: 40 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontFamily: font.regular, fontSize: 16 },
})

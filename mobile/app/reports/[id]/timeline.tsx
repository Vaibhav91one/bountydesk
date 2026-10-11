/** M8 Timeline. Append-only event list for a case file.
 *
 * Matches docs/site/screens/m8.html pixel for pixel: a screen header, a meta
 * line ("BD-1042 · N events in …"), a FlatList of vertical timeline rows with
 * a phase-coloured dot and mono UTC time, and a footnote. Each event reads
 * from GET /reports/[id].events.
 */
import { FlatList, View, Text, StyleSheet } from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useApiQuery, ApiError } from "@/lib/use-query"
import type { MobileCaseFile, CaseEvent } from "@/lib/types"
import { ScreenHeader, EmptyState } from "@/components/primitives"
import { useTheme } from "@/theme"
import type { PhaseKey } from "@/lib/phases"

/**
 * Derive a display label and phase dot from a raw session_event type.
 * The mockup (m8.html) curates nine events; the server emits more event types
 * than that, so each maps to a readable title. Phases drive the dot colour via
 * c.css's .c-* variables, matched by lib/phases.ts.
 */
const EVENT_LABELS: Record<string, string> = {
  "intake.accepted": "Received",
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
  "approval.approved": "Approved",
  "approval.denied": "Denied",
  "delivery.sent": "Delivery sent",
  "delivery.delivered": "Delivered",
}

/** Derive the phase color key for an event type. Matches m8's dots. */
function phaseForEvent(type: string): PhaseKey {
  if (type === "intake.accepted") return "delivered"
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

/** Derive label, subtitle, and phase from a case event. */
function describeEvent(event: CaseEvent): { label: string; subtitle: string; phase: PhaseKey } {
  let label: string
  if (event.toolName) {
    label = EVENT_LABELS[`agent.tool_call:${event.toolName}`] ?? event.toolName
  } else {
    label = EVENT_LABELS[event.type] ?? event.type
  }
  return { label, subtitle: event.argsPreview ?? "", phase: phaseForEvent(event.type) }
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
  const { colors, phase, typography } = useTheme()
  const { data: report, error, isError } = useApiQuery<MobileCaseFile>(`/reports/${id}`)

  const isAuthError = error instanceof ApiError && (error.status === 401 || error.status === 403)
  if (isError && !isAuthError) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.error, { color: colors.red }]}>{error?.message}</Text>
      </View>
    )
  }

  const events = report?.events ?? []
  const badge = report?.id ?? ""
  const metaLabel = `${badge} · ${events.length} events`

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="Timeline"
        meta={metaLabel}
        back
        backLabel="Case file"
        onBack={() => router.back()}
      />
      <FlatList
        data={events}
        keyExtractor={(item) => item.seq.toString()}
        renderItem={({ item }) => <TimelineRow event={item} colors={colors} phase={phase} mono={typography.fontMono} />}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <EmptyState heading="No events" body="This report has no timeline events." inline />
          </View>
        }
      />
      <Text style={[styles.note, { color: colors.muted, fontFamily: typography.fontFamily }]}>
        Times are UTC. Session events are append-only and cannot be edited.
      </Text>
    </View>
  )
}

interface TimelineRowProps {
  event: CaseEvent
  colors: ReturnType<typeof useTheme>["colors"]
  phase: ReturnType<typeof useTheme>["phase"]
  mono: string
}

function TimelineRow({ event, colors, phase: phaseColors, mono }: TimelineRowProps) {
  const { label, subtitle, phase: phaseKey } = describeEvent(event)
  const time = formatUtc(event.at)
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: phaseColors[phaseKey] }]} />
      <View style={styles.rowMain}>
        <Text style={[styles.rowTitle, { color: colors.foreground }]}>{label}</Text>
        {subtitle ? (
          <Text style={[styles.rowSub, { color: colors.muted }]}>{subtitle}</Text>
        ) : null}
      </View>
      <Text style={[styles.rowTime, { color: colors.muted, fontFamily: mono }]}>{time}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  list: {
    paddingTop: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
    position: "relative",
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
  },
  dot: {
    width: 10,
    height: 10,
    marginTop: 2,
    borderRadius: 5,
  },
  rowTitle: {
    fontSize: 17,
    fontWeight: "500",
    lineHeight: 22,
  },
  rowSub: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 3,
  },
  rowTime: {
    fontSize: 13,
    lineHeight: 19,
  },
  empty: {
    paddingHorizontal: 20,
    paddingTop: 40,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 20,
    paddingBottom: 20,
    textAlign: "center",
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  error: {
    fontSize: 16,
  },
})

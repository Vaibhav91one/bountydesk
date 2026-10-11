/** M9 Tool calls. Investigation tool calls for a case file.
 *
 * Matches docs/site/screens/m9.html: two sections (Investigation and Human
 * gate), each a list of tool-call rows with the tool name in mono, the
 * allowlisted argument preview in mono, and a status pill. Data comes from
 * GET /reports/[id].toolCalls (the filtered event list where toolName is set).
 */
import { View, Text, FlatList, StyleSheet } from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useApiQuery, ApiError } from "@/lib/use-query"
import type { MobileCaseFile, CaseEvent } from "@/lib/types"
import { ScreenHeader, EmptyState } from "@/components/primitives"
import { Pill } from "@/components/ui/Pill"
import { useTheme } from "@/theme"
import type { PhaseKey } from "@/lib/phases"

type ToolCallStatus = "Pass" | "Allowed" | "Denied" | "Gated"

/**
 * The mockup shows Pass, Allowed, Denied and Gated pills. The API's toolCalls
 * array does not carry a result/status field, so the status is derived from
 * the tool name. scope_check always passes, publish_verdict is always gated,
 * and the probes are Allowed. A Denied probe requires a matching
 * agent.scope_tool_denied event, which the mobile CaseEvent type does not
 * surface — that is an OPEN QUESTION for the API to add a `result` field.
 */
function deriveStatus(toolName: string | null): ToolCallStatus {
  if (toolName === "publish_verdict") return "Gated"
  if (toolName === "scope_check") return "Pass"
  return "Allowed"
}

function statusPhaseKey(status: ToolCallStatus): PhaseKey {
  if (status === "Denied") return "closed"
  if (status === "Gated") return "approval"
  return "delivered"
}

function splitSections(toolCalls: CaseEvent[]): { investigation: CaseEvent[]; humanGate: CaseEvent[] } {
  const investigation: CaseEvent[] = []
  const humanGate: CaseEvent[] = []
  for (const call of toolCalls) {
    if (call.toolName === "publish_verdict") {
      humanGate.push(call)
    } else {
      investigation.push(call)
    }
  }
  return { investigation, humanGate }
}

export default function ToolCallsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { colors, phase, typography } = useTheme()
  const { data: report, error, isError } = useApiQuery<MobileCaseFile>(`/reports/${id}`)

  const isAuthError = error instanceof ApiError && (error.status === 401 || error.status === 403)
  if (isAuthError) return null
  if (isError) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.error, { color: colors.red }]}>{error?.message}</Text>
      </View>
    )
  }

  const toolCalls = report?.toolCalls ?? []
  const { investigation, humanGate } = splitSections(toolCalls)
  const meta = `${report?.id ?? ""} · ${toolCalls.length} calls`

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="Tool calls"
        meta={meta}
        back
        backLabel="Case file"
        onBack={() => router.back()}
      />

      {toolCalls.length === 0 ? (
        <View style={styles.empty}>
          <EmptyState heading="No tool calls" body="No investigation tools have been called yet." inline />
        </View>
      ) : (
        <FlatList
          data={[
            { key: "investigation", title: "Investigation", calls: investigation },
            { key: "human-gate", title: "Human gate", calls: humanGate },
          ].filter((s) => s.calls.length > 0)}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) => (
            <Section
              title={item.title}
              calls={item.calls}
              colors={colors}
              phase={phase}
              mono={typography.fontMono}
            />
          )}
          contentContainerStyle={styles.list}
        />
      )}

      <Text style={[styles.note, { color: colors.muted, fontFamily: typography.fontFamily }]}>
        The target comes from the server-held profile, never from text the agent wrote. A call outside it is refused.
      </Text>
    </View>
  )
}

interface SectionProps {
  title: string
  calls: CaseEvent[]
  colors: ReturnType<typeof useTheme>["colors"]
  phase: ReturnType<typeof useTheme>["phase"]
  mono: string
}

function Section({ title, calls, colors, phase, mono }: SectionProps) {
  if (calls.length === 0) return null
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionHeader, { color: colors.foreground }]}>{title}</Text>
      <View style={[styles.card, { backgroundColor: colors.card }]}>
        {calls.map((call) => {
          const status = deriveStatus(call.toolName)
          const statusPhase = statusPhaseKey(status)
          return (
            <ToolCallRow
              key={call.seq}
              call={call}
              status={status}
              statusPhase={statusPhase}
              colors={colors}
              phase={phase}
              mono={mono}
            />
          )
        })}
      </View>
    </View>
  )
}

interface ToolCallRowProps {
  call: CaseEvent
  status: ToolCallStatus
  statusPhase: PhaseKey
  colors: ReturnType<typeof useTheme>["colors"]
  phase: ReturnType<typeof useTheme>["phase"]
  mono: string
}

function ToolCallRow({ call, status, statusPhase, colors, phase, mono }: ToolCallRowProps) {
  const toolName = call.toolName ?? "unknown"
  const argsPreview = call.argsPreview ?? ""
  return (
    <View style={styles.item}>
      <View style={styles.itemMain}>
        <Text style={[styles.toolName, { color: colors.foreground, fontFamily: mono }]}>{toolName}</Text>
        {argsPreview ? (
          <Text style={[styles.argsPreview, { color: colors.muted, fontFamily: mono }]}>{argsPreview}</Text>
        ) : null}
      </View>
      <Pill
        label={status}
        color={phase[statusPhase]}
        style={styles.pill}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  list: {
    paddingTop: 8,
  },
  section: {
    marginBottom: 28,
  },
  sectionHeader: {
    fontSize: 20,
    fontWeight: "600",
    lineHeight: 24,
    marginHorizontal: 20,
    marginBottom: 10,
  },
  card: {
    marginHorizontal: 16,
    borderRadius: 24,
    overflow: "hidden",
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 56,
    paddingHorizontal: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  itemMain: {
    flex: 1,
    minWidth: 0,
  },
  toolName: {
    fontSize: 15,
    fontWeight: "500",
    lineHeight: 20,
  },
  argsPreview: {
    fontSize: 12,
    lineHeight: 18,
    marginTop: 3,
  },
  pill: {
    marginLeft: 12,
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

/** M9 Tool calls. Investigation tool calls for a case file.
 *
 * Matches docs/site/screens/m9.html: two sections (Investigation and Human
 * gate), each a list of tool-call rows with the tool name in mono, the
 * allowlisted argument preview in mono, and a status pill. Data comes from
 * GET /reports/[id].toolCalls (the filtered event list where toolName is set).
 */
import { View, Text, ScrollView, StyleSheet } from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useApiQuery, ApiError } from "@/lib/use-query"
import type { MobileCaseFile, CaseEvent } from "@/lib/types"
import { ScreenHeader, ScreenTitle, EmptyState, LoadingState, PhasePill } from "@/components/primitives"
import { Pill } from "@/components/ui/Pill"
import { ListCard, SectionHead } from "@/components/ReportList"
import { BottomFade, ItemLine, Note } from "@/components/CaseUi"
import { toolCallsOnly } from "@/lib/toolCalls"
import { useTheme } from "@/theme"
import { font } from "@/lib/fonts"

type ToolCallStatus = "Pass" | "Allowed" | "Denied" | "Gated"

/**
 * The mockup shows Pass, Allowed, Denied and Gated pills. The mobile API's
 * toolCalls array carries both call events and agent.scope_tool_denied events
 * (the mobile CaseEvent type surfaces toolName but not the underlying data
 * field). So:
 *   1. Filter toolCalls to actual calls by excluding scope_tool_denied type.
 *   2. For each call, pair it with the next scope_tool_denied event for the
 *      same tool in sequence order — each row's status comes from its own
 *      result, never from a different call with the same name.
 * scope_check always passes, publish_verdict is always gated, and probes are
 * Allowed unless a matching denial event follows.
 *
 * OPEN QUESTION: the mobile CaseEvent type lacks a `data` field and the mobile
 * view drops eventKey (the call id), so the denial reason is not accessible and
 * matching is by toolName + sequence proximity only.
 */
/** Find a scope_tool_denied event for the same toolName that comes after call.seq
 *  but before the next tool_call event for the same toolName. This pairs each
 *  actual call with its own scope-guard denial, not a different call's. */
function findDenialAfter(call: CaseEvent, events: CaseEvent[]): boolean {
  const allEvents = events
  const callSeq = call.seq
  const tool = call.toolName
  // Find the next tool_call event (same tool) after this call.
  const nextCallSeq = allEvents
    .filter((e) => e.type.startsWith("agent.tool_call:") && e.toolName === tool && e.seq > callSeq)
    .sort((a, b) => a.seq - b.seq)[0]?.seq

  // A matching denial sits between call.seq and the next call of the same tool.
  return allEvents.some(
    (e) =>
      e.type === "agent.scope_tool_denied" &&
      e.toolName === tool &&
      e.seq > callSeq &&
      (nextCallSeq === undefined || e.seq < nextCallSeq),
  )
}

function deriveStatus(call: CaseEvent, events: CaseEvent[]): ToolCallStatus {
  if (call.toolName === "publish_verdict") return "Gated"
  if (call.toolName === "scope_check") return "Pass"
  if (findDenialAfter(call, events)) return "Denied"
  return "Allowed"
}

function splitSections(toolCalls: CaseEvent[]): { investigation: CaseEvent[]; humanGate: CaseEvent[] } {
  const actualCalls = toolCallsOnly(toolCalls)
  const investigation: CaseEvent[] = []
  const humanGate: CaseEvent[] = []
  for (const call of actualCalls) {
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
  const { colors } = useTheme()
  const { data: report, error, isError, isLoading } = useApiQuery<MobileCaseFile>(`/reports/${id}`)

  const isAuthError = error instanceof ApiError && (error.status === 401 || error.status === 403)
  if (isAuthError) return null
  if (isError) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.error, { color: colors.red }]}>{error?.message}</Text>
      </View>
    )
  }

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader back backLabel="Case file" />
        <LoadingState label="Loading tool calls" />
      </View>
    )
  }

  const toolCalls = report?.toolCalls ?? []
  // A denial is mirrored in both lists; either may be the one that carries it.
  const allEvents = [...(report?.events ?? []), ...toolCalls]
  const { investigation, humanGate } = splitSections(toolCalls)
  const renderedCount = investigation.length + humanGate.length
  const meta = `${report?.sourceLabel ?? ""} · ${renderedCount} calls`
  const sections = [
    {
      key: "investigation",
      title: "Investigation",
      calls: investigation,
      note: "The target comes from the server-held profile, never from text the agent wrote. A call outside it is refused.",
    },
    {
      key: "human-gate",
      title: "Human gate",
      calls: humanGate,
      note: "publish_verdict waits for a reviewer to approve the exact drafted comment.",
    },
  ].filter((s) => s.calls.length > 0)

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader back backLabel="Case file" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <ScreenTitle title="Tool calls" meta={meta} metaBottom={20} />
        {toolCalls.length === 0 ? (
          <View style={styles.empty}>
            <EmptyState heading="No tool calls" body="No investigation tools have been called yet." inline />
          </View>
        ) : (
          sections.map((s) => (
            <View key={s.key} style={styles.section}>
              <SectionHead title={s.title} />
              <ListCard>
                {s.calls.map((call, i) => (
                  <ItemLine
                    key={call.seq}
                    mono
                    divider={i > 0}
                    title={call.toolName ?? "unknown"}
                    subtitle={call.argsPreview ?? undefined}
                    trailing={<StatusPill status={deriveStatus(call, allEvents)} />}
                  />
                ))}
              </ListCard>
              <Note>{s.note}</Note>
            </View>
          ))
        )}
      </ScrollView>
      <BottomFade />
    </View>
  )
}

/** Pass, Allowed and Denied read as the phase pills do; Denied is red, which no phase is. */
function StatusPill({ status }: { status: ToolCallStatus }) {
  const { colors } = useTheme()
  if (status === "Denied") return <Pill label={status} color={colors.red} />
  return <PhasePill phase={status === "Gated" ? "approval" : "delivered"} label={status} />
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 150 },
  section: { marginBottom: 28 },
  empty: { paddingHorizontal: 20, paddingTop: 40 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontFamily: font.regular, fontSize: 16 },
})

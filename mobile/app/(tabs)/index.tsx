/** M4 Home. Needs you carousel, active and delivered report lists.
 * Matches docs/site/screens/m4.html exactly.
 *
 * The native tab bar (Home/Queue/Reports) is provided by the parent
 * (tabs)/_layout.tsx via expo-router/unstable-native-tabs. The Review FAB and
 * the bell/more chrome are overlay components rendered on this screen. The
 * section header and phase pills come from the shared primitives so M5 and
 * later screens render the same chrome.
 */
import { View, Text, ScrollView, StyleSheet, Dimensions, Pressable } from "react-native"
import { useRouter } from "expo-router"

import { useApiQuery, ApiError } from "@/lib/use-query"
import type { HomeSummary, QueueColumnView } from "@/lib/types"
import { useTheme } from "@/theme"
import { TopBarPill } from "@/components/TopBarPill"
import { ReviewFab } from "@/components/ReviewFab"
import { PhasePill, SectionHeader, Card } from "@/components/primitives"
import { Pill } from "@/components/ui/Pill"
import type { PhaseKey } from "@/lib/phases"

const { width: SCREEN_WIDTH } = Dimensions.get("window")
const CARD_WIDTH = SCREEN_WIDTH / 2 - 28

/** The queued board, as it crosses the wire to the phone. */
export type QueueResponse = {
  columns: QueueColumnView[]
}

/**
 * Map a queued column key to the PhaseKey the phase pill colours by.
 * The board's column keys and the theme phase keys are not identical:
 * "analysis-only" and "awaiting-approval" carry the phase colours of
 * `analysis` and `approval`. This is the single place that bridge lives.
 */
// Every report state named explicitly: a state missing here would fall to a wrong pill colour.
const STATE_TO_PHASE: Record<string, PhaseKey> = {
  TRIAGING: "triaging",
  NEEDS_DECISION: "triaging",
  REPRODUCING: "reproducing",
  ANALYSIS_ONLY: "analysis",
  AWAITING_APPROVAL: "approval",
  DELIVERING: "delivered",
  DELIVERED: "delivered",
}

/** The phase pill for a report state; the five terminal non-delivered states are closed. */
function stateToPhaseKey(state: string): PhaseKey {
  return STATE_TO_PHASE[state] ?? "closed"
}

/**
 * Render a queued age as "12 min ago" rather than the server's coarse
 * ageLabel, because the home card carries the full relative age. The API
 * returns updatedAt as an ISO string.
 */
function relativeTime(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return `${days} d ago`
}

/**
 * Derive the outcome pill label and colour for a needs-you card.
 * REPRODUCED and NOT_REPRODUCED name themselves; anything without an
 * outcome (or INCONCLUSIVE) reads as "Analysis only".
 */
function outcomePill(outcome: string | null): { label: string; color: PhaseKey } {
  if (outcome === "REPRODUCED") return { label: "Reproduced", color: "delivered" }
  if (outcome === "NOT_REPRODUCED") return { label: "Not reproduced", color: "analysis" }
  return { label: "Analysis only", color: "analysis" }
}

export default function HomeScreen() {
  const { colors, phase } = useTheme()
  const router = useRouter()
  const { data: summary, error } = useApiQuery<HomeSummary>("/home")
  const { data: queue, error: queueError } = useApiQuery<QueueResponse>("/queue?limit=50")

  const columns = queue?.columns ?? []
  const colByKey = (key: string) => columns.find((c) => c.key === key)
  const awaitingCards = colByKey("awaiting-approval")?.cards ?? []
  const analysisCards = colByKey("analysis-only")?.cards ?? []
  const triagingCards = colByKey("triaging")?.cards ?? []
  const deliveredCards = colByKey("delivered")?.cards ?? []
  const closedCards = colByKey("closed")?.cards ?? []
  // Section counts are the server totals; the rows below show only the newest few.
  const total = (key: string) => colByKey(key)?.total ?? 0
  const activeTotal = total("analysis-only") + total("triaging")
  const deliveredTotal = total("delivered") + total("closed")

  // 401/403 are handled by useApiQuery's shared effect (sign out / not-authorized).
  // Only surface a retryable inline message for other errors.
  // A failed /queue must not read as an empty board ("Nothing needs you"), so either failure shows the error.
  const failed = error ?? queueError
  const isAuthError = failed instanceof ApiError && (failed.status === 401 || failed.status === 403)
  if (failed && !isAuthError) {
    return (
      <View style={styles.centered}>
        <Text style={[styles.error, { color: colors.red }]}>{failed.message}</Text>
      </View>
    )
  }

  if (error) {
    return null
  }

  const active = activeRows(analysisCards, triagingCards)
  const delivered = deliveredRows(deliveredCards, closedCards)

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
      <Text style={[styles.h1, { color: colors.foreground }]}>Home</Text>
      <Text style={[styles.hmeta, { color: colors.muted }]}>
        {summary?.reports ?? 10} total reports · {summary?.open ?? 8} open
      </Text>

      {/* Needs you carousel (.rail with .nc cards) */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={CARD_WIDTH + 12}
        decelerationRate="fast"
        contentContainerStyle={styles.rail}
      >
        {awaitingCards.length === 0 ? (
          <View style={[styles.ncCard, { width: CARD_WIDTH, backgroundColor: colors.card }]}>
            <Text style={[styles.ncTitle, { color: colors.foreground }]}>Nothing needs you</Text>
          </View>
        ) : (
          awaitingCards.map((c) => (
            <NeedYouCard
              key={c.id}
              card={c}
              width={CARD_WIDTH}
              phase={phase}
              onPress={() => router.push(`/reports/${c.id}/sign-the-verdict`)}
            />
          ))
        )}
      </ScrollView>

      {/* Active section */}
      {active.length > 0 ? (
        <View style={styles.section}>
          <SectionHeader title="Active" count={activeTotal} />
          <Card style={styles.list}>
            {active.map((r) => (
              <Pressable key={r.id} onPress={() => router.push(`/reports/${r.id}`)}>
                <ActiveRow card={r} phase={phase} />
              </Pressable>
            ))}
          </Card>
        </View>
      ) : null}

      {/* Delivered section */}
      {delivered.length > 0 ? (
        <View style={styles.section}>
          <SectionHeader title="Delivered" count={deliveredTotal} />
          <Card style={styles.list}>
            {delivered.map((r) => (
              <Pressable key={r.id} onPress={() => router.push(`/reports/${r.id}`)}>
                <ActiveRow card={r} phase={phase} />
              </Pressable>
            ))}
          </Card>
        </View>
      ) : null}

      <Text style={[styles.note, { color: colors.muted }]}>
        Verdicts are only sent after you approve the exact drafted comment.
      </Text>
      </ScrollView>

      <TopBarPill />
      <ReviewFab />
    </View>
  )
}

/** Combine analysis-only and triaging cards, newest first, cap at 3. */
function activeRows(analysisCards: QueueColumnView["cards"], triagingCards: QueueColumnView["cards"]) {
  return [...analysisCards, ...triagingCards]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 3)
}

/** Combine delivered and closed cards, newest first, cap at 2. */
function deliveredRows(deliveredCards: QueueColumnView["cards"], closedCards: QueueColumnView["cards"]) {
  return [...deliveredCards, ...closedCards]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 2)
}

interface NeedYouCardProps {
  card: QueueColumnView["cards"][number]
  width: number
  phase: ReturnType<typeof useTheme>["phase"]
  onPress: () => void
}

function NeedYouCard({ card, width, phase, onPress }: NeedYouCardProps) {
  const { colors } = useTheme()
  const outcome = outcomePill(card.outcome)
  return (
    <Pressable onPress={onPress} style={{ width, flexShrink: 0 }}>
      <View style={[styles.ncCard, { backgroundColor: colors.card }]}>
        <View style={styles.ncTop}>
          <PhasePill phase="approval" style={{ alignSelf: "flex-start" }} />
          <Text style={[styles.ncTime, { color: colors.muted }]}>{relativeTime(card.updatedAt)}</Text>
        </View>
        <Text style={[styles.ncTitle, { color: colors.foreground }]}>{card.title}</Text>
        <Text style={[styles.ncSubtitle, { color: colors.muted }]}>{card.sourceLabel} · {card.targetName ?? "No target"}</Text>
        <View style={styles.ncFoot}>
          <Pill label={outcome.label} color={phase[outcome.color]} style={styles.outcomePill} />
        </View>
      </View>
    </Pressable>
  )
}

interface ActiveRowProps {
  card: QueueColumnView["cards"][number]
  phase: ReturnType<typeof useTheme>["phase"]
}

function ActiveRow({ card, phase }: ActiveRowProps) {
  const { colors } = useTheme()
  const ph = stateToPhaseKey(card.state)
  return (
    <View style={styles.item}>
      <View style={styles.main}>
        <Text style={[styles.itemT, { color: colors.foreground }]}>{card.title}</Text>
        <Text style={[styles.itemS, { color: colors.muted }]}>{card.sourceLabel} · {card.targetName ?? "No target"}</Text>
      </View>
      <View style={styles.itemR}>
        <PhasePill phase={ph} style={styles.rowPill} />
        <Text style={[styles.itemB, { color: colors.muted }]}>{relativeTime(card.updatedAt)}</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingTop: 8 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontSize: 16 },
  h1: { fontSize: 28, fontWeight: "700", letterSpacing: -0.03 * 28, marginTop: 8, marginBottom: 4 },
  hmeta: { fontSize: 15, marginBottom: 8 },
  rail: { gap: 12, paddingBottom: 12, marginBottom: 4 },
  ncCard: { flexShrink: 0, borderRadius: 24, padding: 18, gap: 10 },
  ncTop: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 4 },
  ncTime: { fontSize: 13 },
  ncTitle: { fontSize: 19, fontWeight: "600", lineHeight: 24, letterSpacing: -0.02, marginTop: -4 },
  ncSubtitle: { fontSize: 13 },
  ncFoot: { marginTop: "auto", flexDirection: "row", justifyContent: "flex-end", alignItems: "center", paddingTop: 12 },
  outcomePill: { alignSelf: "flex-end" },
  section: { marginBottom: 28 },
  list: { marginHorizontal: 16, borderRadius: 24, overflow: "hidden" },
  item: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 10, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth },
  main: { flex: 1, minWidth: 0 },
  itemT: { fontSize: 17, fontWeight: "500", lineHeight: 20 },
  itemS: { fontSize: 13, marginTop: 3 },
  itemR: { flexShrink: 0, flexDirection: "column", alignItems: "flex-end", gap: 6 },
  itemB: { fontSize: 13 },
  rowPill: { marginTop: 0, marginBottom: 0 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 20, marginTop: 12, marginBottom: 60 },
})

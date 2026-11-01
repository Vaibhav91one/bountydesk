/** M4 Home. Needs you carousel, active and delivered report lists.
 * Matches docs/site/screens/m4.html exactly.
 *
 * The dock (Home/Queue/Reports plus the Review FAB) is drawn by (tabs)/_layout.tsx. The bell/more
 * chrome is an overlay rendered on this screen. Section headers and rows come from
 * components/ReportList so M5 and M6 render the same chrome.
 */
import { useState } from "react"
import { View, Text, ScrollView, StyleSheet, Pressable } from "react-native"
import { useRouter } from "expo-router"

import { useApiQuery, ApiError } from "@/lib/use-query"
import type { HomeSummary, QueueColumnView } from "@/lib/types"
import { useTheme } from "@/theme"
import { TopBarPill } from "@/components/TopBarPill"
import { EmptyState, LoadingState, PhasePill, TOP_INSET, phaseLabel } from "@/components/primitives"
import { PopoverMenu, type AnchorRect } from "@/components/PopoverMenu"
import { ListCard, ReportRow, SectionHead } from "@/components/ReportList"
import { Icon } from "@/components/icons"
import { ageText } from "@/lib/age"
import type { PhaseKey } from "@/lib/phases"
import { font } from "@/lib/fonts"

const CARD_WIDTH = 286
const RAIL_GAP = 12

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

/** The outcome line on a needs-you card. Anything without an outcome (or INCONCLUSIVE) reads as analysis only. */
function outcomeLabel(outcome: string | null): string {
  if (outcome === "REPRODUCED") return "Reproduced"
  if (outcome === "NOT_REPRODUCED") return "Not reproduced"
  return "Analysis only"
}

const SEVERITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 } as const

type Sort = "newest" | "severity"
type Card = QueueColumnView["cards"][number]

/** Needs-you order: newest first by default, or by severity (reports without one last). */
export function sortNeedsYou(cards: Card[], sort: Sort): Card[] {
  const byNewest = [...cards].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  if (sort === "newest") return byNewest
  const rank = (c: Card) => (c.severity ? SEVERITY_RANK[c.severity] : 5)
  return byNewest.sort((a, b) => rank(a) - rank(b))
}

const ACTIVE_ROWS = 3
const ACTIVE_PHASE_ORDER: Record<string, number> = { REPRODUCING: 0, ANALYSIS_ONLY: 1, TRIAGING: 2, NEEDS_DECISION: 2 }

/**
 * Active rows for the home list: by phase (reproducing, analysis, triaging), the report that has
 * waited longest first, and reports the agent is running right now last since they resolve on their own.
 */
export function activeRows(cards: Card[]): Card[] {
  const phase = (c: Card) => ACTIVE_PHASE_ORDER[c.state] ?? 3
  return [...cards]
    .sort((a, b) => Number(a.investigating) - Number(b.investigating) || phase(a) - phase(b) || (a.updatedAt < b.updatedAt ? -1 : 1))
    .slice(0, ACTIVE_ROWS)
}

export default function HomeScreen() {
  const { colors } = useTheme()
  const router = useRouter()
  const [sort, setSort] = useState<Sort>("newest")
  const [menuAnchor, setMenuAnchor] = useState<AnchorRect | null>(null)
  const { data: summary, error } = useApiQuery<HomeSummary>("/home")
  const { data: queue, error: queueError, isLoading: queueLoading } = useApiQuery<QueueResponse>("/queue?limit=50")

  const columns = queue?.columns ?? []
  const colByKey = (key: string) => columns.find((c) => c.key === key)
  const awaitingCards = sortNeedsYou(colByKey("awaiting-approval")?.cards ?? [], sort)
  const activeCards = [...(colByKey("analysis-only")?.cards ?? []), ...(colByKey("triaging")?.cards ?? [])]
  const deliveredCards = colByKey("delivered")?.cards ?? []
  const closedCards = colByKey("closed")?.cards ?? []
  // Section counts are the server totals; the rows below show only the newest few.
  const total = (key: string) => colByKey(key)?.total ?? 0
  const awaitingTotal = summary?.needsYou ?? total("awaiting-approval")
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

  const active = activeRows(activeCards)
  const delivered = deliveredRows(deliveredCards, closedCards)
  const moreActive = activeTotal - active.length

  const sortItems = [
    { label: "Sort by newest", onPress: () => setSort("newest") },
    { label: "Sort by severity", onPress: () => setSort("severity") },
  ]

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.section}>
          <SectionHead title="Needs you" count={awaitingTotal} onPress={() => router.push("/queue")} onMore={setMenuAnchor} />
          {queueLoading ? (
            <LoadingState label="Loading your queue" inline />
          ) : awaitingCards.length === 0 ? (
            <EmptyState mascot="chilling" heading="Nothing needs you" inline />
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              snapToInterval={CARD_WIDTH + RAIL_GAP}
              decelerationRate="fast"
              contentContainerStyle={styles.rail}
            >
              {awaitingCards.map((c) => (
                <NeedYouCard key={c.id} card={c} onPress={() => router.push(`/reports/${c.id}/sign-the-verdict`)} />
              ))}
            </ScrollView>
          )}
        </View>

        {active.length > 0 ? (
          <View style={styles.section}>
            <SectionHead title="Active" count={activeTotal} onPress={() => router.push("/queue")} onMore={setMenuAnchor} />
            <ListCard>
              {active.map((r, i) => (
                <HomeRow key={r.id} card={r} divider={i > 0} onPress={() => router.push(`/reports/${r.id}`)} />
              ))}
              {moreActive > 0 ? (
                <Pressable onPress={() => router.push("/queue")} style={styles.more}>
                  <View style={[styles.divider, { backgroundColor: colors.line }]} />
                  <Text style={[styles.moreText, { color: colors.muted }]}>{moreActive} more in progress</Text>
                  <Icon name="chev" size={18} stroke={colors.faint} strokeWidth={2.4} />
                </Pressable>
              ) : null}
            </ListCard>
          </View>
        ) : null}

        {delivered.length > 0 ? (
          <View style={styles.section}>
            <SectionHead title="Delivered" count={deliveredTotal} onPress={() => router.push("/reports")} onMore={setMenuAnchor} />
            <ListCard>
              {delivered.map((r, i) => (
                <HomeRow key={r.id} card={r} divider={i > 0} onPress={() => router.push(`/reports/${r.id}`)} />
              ))}
            </ListCard>
            <Text style={[styles.note, { color: colors.muted }]}>
              Verdicts are only sent after you approve the exact drafted comment.
            </Text>
          </View>
        ) : null}
      </ScrollView>

      <PopoverMenu anchor={menuAnchor} items={sortItems} onClose={() => setMenuAnchor(null)} />
      <TopBarPill />
    </View>
  )
}

/** Delivered and closed cards, newest first, cap at 2. */
function deliveredRows(deliveredCards: Card[], closedCards: Card[]) {
  return [...deliveredCards, ...closedCards]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 2)
}

function NeedYouCard({ card, onPress }: { card: Card; onPress: () => void }) {
  const { colors, phase } = useTheme()
  const sevColor = card.severity === "Critical" || card.severity === "High" ? colors.red : card.severity === "Medium" ? phase.approval : colors.muted
  return (
    <Pressable
      onPress={onPress}
      style={[styles.nc, { backgroundColor: colors.card, boxShadow: `0 0 0 1px ${colors["glass-edge"]}` }]}
    >
      <View style={styles.ncTop}>
        <PhasePill phase="approval" />
        <Text style={[styles.ncTime, { color: colors.muted }]}>{ageText(card.updatedAt, true)}</Text>
      </View>
      <Text style={[styles.ncTitle, { color: colors.foreground }]} numberOfLines={2}>{card.title}</Text>
      <Text style={[styles.ncMeta, { color: colors.muted }]}>{card.sourceLabel} · {card.targetName ?? "No target"}{card.targetVersion ? ` ${card.targetVersion}` : ""}</Text>
      <View style={[styles.ncFoot, { borderTopColor: colors.line }]}>
        <Text style={[styles.ncSev, { color: sevColor }]}>{card.severity ?? ""}</Text>
        <Text style={[styles.ncOutcome, { color: colors.muted }]}>{outcomeLabel(card.outcome)}</Text>
      </View>
    </Pressable>
  )
}

function HomeRow({ card, divider, onPress }: { card: Card; divider: boolean; onPress: () => void }) {
  const ph = stateToPhaseKey(card.state)
  return (
    <ReportRow
      title={card.title}
      subtitle={`${card.sourceLabel} · ${card.targetName ?? "No target"}`}
      phase={ph}
      pillLabel={phaseLabel(ph)}
      age={ageText(card.updatedAt)}
      divider={divider}
      onPress={onPress}
    />
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { paddingTop: TOP_INSET, paddingBottom: 150 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontFamily: font.regular, fontSize: 16 },
  section: { marginBottom: 28 },
  rail: { gap: RAIL_GAP, paddingHorizontal: 16 },
  nc: { width: CARD_WIDTH, minHeight: 176, borderRadius: 24, paddingVertical: 16, paddingHorizontal: 18, gap: 10 },
  ncTop: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", columnGap: 8, rowGap: 4 },
  ncTime: { fontFamily: font.regular, fontSize: 13, lineHeight: 17.5 },
  ncTitle: { fontFamily: font.semibold, fontSize: 19, lineHeight: 23.75, letterSpacing: -0.38 },
  ncMeta: { fontFamily: font.regular, fontSize: 13, lineHeight: 17.5, marginTop: -4 },
  ncFoot: { marginTop: "auto", flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 12, borderTopWidth: 1 },
  ncSev: { fontFamily: font.semibold, fontSize: 15, lineHeight: 20.25 },
  ncOutcome: { fontFamily: font.regular, fontSize: 15, lineHeight: 20.25 },
  more: { flexDirection: "row", alignItems: "center", minHeight: 52, paddingVertical: 10, paddingHorizontal: 18 },
  divider: { position: "absolute", top: 0, left: 18, right: 18, height: 1 },
  moreText: { flex: 1, fontFamily: font.regular, fontSize: 15, lineHeight: 20.25 },
  note: { fontFamily: font.regular, fontSize: 13, lineHeight: 18.2, paddingHorizontal: 20, paddingTop: 10 },
})

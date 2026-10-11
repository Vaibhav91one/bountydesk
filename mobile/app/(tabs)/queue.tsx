/** M5 Queue. Reports grouped by phase: Awaiting approval, Reproducing,
 * Analysis only, Triaging, each with a count, a footnote, and a 450ms
 * long-press menu on every row. Matches docs/site/screens/m5.html.
 *
 * Data: GET /api/mobile/v1/queue returns columns keyed by phase. The server
 * folds REPRODUCING and ANALYSIS_ONLY into one "analysis-only" column, so the
 * client splits it back into Reproducing and Analysis only sections, matching
 * the mockup. Only the four active phases render; Delivered and Closed live on
 * the Reports tab.
 */
import { useState } from "react"
import { View, Text, ScrollView, StyleSheet, Pressable, ActivityIndicator, Share } from "react-native"
import { useRouter } from "expo-router"
import * as Clipboard from "expo-clipboard"
import { useApiQuery, ApiError } from "@/lib/use-query"
import type { QueueCard } from "@/lib/types"
import { useTheme } from "@/theme"
import { TopBarPill } from "@/components/TopBarPill"
import { ReviewFab } from "@/components/ReviewFab"
import { PhasePill, LongPressMenu, ToastProvider, useToast, phaseLabel } from "@/components/primitives"
import type { PhaseKey } from "@/lib/phases"

interface QueueColumnView {
  key: string
  label: string
  total: number
  cards: QueueCardView[]
  nextOffset: number | null
}

interface QueueCardView extends QueueCard {
  ageLabel: string
}

/** Display a report id using sourceLabel per the mockup. */
function idLabel(card: QueueCardView): string {
  return card.sourceLabel ?? card.id
}

/** Map internal channel names to the labels shown in the mockups. */
const CHANNEL_LABELS: Record<string, string> = {
  github: "GitHub issue",
  email: "Email",
  upload: "Upload",
  advisory: "Security advisory",
}

interface QueueResponse {
  columns: QueueColumnView[]
}

/** Map a card state to the PhaseKey used by PhasePill. */
const STATE_TO_PHASE: Record<string, PhaseKey> = {
  TRIAGING: "triaging",
  NEEDS_DECISION: "triaging",
  REPRODUCING: "reproducing",
  ANALYSIS_ONLY: "analysis",
  AWAITING_APPROVAL: "approval",
  DELIVERING: "delivered",
  DELIVERED: "delivered",
  DENIED: "closed",
  OUT_OF_SCOPE: "closed",
  CANCELLED: "closed",
  EXPIRED: "closed",
}

/** The pill label for a phase in queue rows. The mockup uses "Approval" (not
 * "Awaiting approval") inside list rows; the section header uses the full label. */
function pillLabel(phase: PhaseKey): string {
  if (phase === "approval") return "Approval"
  return phaseLabel(phase)
}

/** Phases shown on the Queue tab, in mockup order. */
const SHOWN_PHASES: { key: string; phase: PhaseKey; label: string }[] = [
  { key: "awaiting-approval", phase: "approval", label: "Awaiting approval" },
  { key: "reproducing", phase: "reproducing", label: "Reproducing" },
  { key: "analysis", phase: "analysis", label: "Analysis only" },
  { key: "triaging", phase: "triaging", label: "Triaging" },
]

function phaseForCard(card: QueueCardView): PhaseKey {
  return STATE_TO_PHASE[card.state] ?? "closed"
}

function openReportsCount(columns: QueueColumnView[]): number {
  // m5.html: "8 open reports" = sum of the four active phases.
  return columns
    .filter((c) => !["delivered", "closed"].includes(c.key))
    .reduce((sum, c) => sum + c.total, 0)
}

function QueueScreenContent() {
  const { colors } = useTheme()
  const router = useRouter()
  const { data, error, isError, isFetching } = useApiQuery<QueueResponse>("/queue?limit=50")
  const toast = useToast()

  const [lpReportId, setLpReportId] = useState<string | null>(null)

  const isAuthError = error instanceof ApiError && (error.status === 401 || error.status === 403)
  if (error && !isAuthError) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.error, { color: colors.red }]}>{error.message}</Text>
      </View>
    )
  }

  const cols = data?.columns ?? []
  const colByKey = new Map(cols.map((c) => [c.key, c]))
  // count is the server's total, not cards.length: a column is paged, so cards can be short of it.
  // Reproducing and Analysis only share one server column with no per-state total, so their counts
  // are the loaded cards, and a short column gets one note under the pair instead of guessing
  // which of the two states lost rows.
  const sections: { key: string; phase: PhaseKey; label: string; cards: QueueCardView[]; count: string; note?: string }[] = []
  const shared = colByKey.get("analysis-only")

  for (const { key, phase, label } of SHOWN_PHASES) {
    if (key === "reproducing" || key === "analysis") {
      const state = key === "reproducing" ? "REPRODUCING" : "ANALYSIS_ONLY"
      const cards = shared ? shared.cards.filter((c) => c.state === state) : []
      const note =
        key === "analysis" && shared && shared.total > shared.cards.length
          ? `Showing the newest ${shared.cards.length} of ${shared.total} reproducing and analysis-only reports.`
          : undefined
      sections.push({ key, phase, label, cards, count: String(cards.length), note })
    } else {
      const col = colByKey.get(key)
      sections.push({ key, phase, label, cards: col ? col.cards : [], count: String(col?.total ?? 0) })
    }
  }

  const openCount = openReportsCount(cols)

  if (!data && !isError && (isFetching || cols.length === 0)) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.brand} size="large" />
        <TopBarPill />
        <ReviewFab />
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.h1, { color: colors.foreground }]}>Queue</Text>
        <Text style={[styles.hmeta, { color: colors.muted }]}>
          {openCount} open reports
        </Text>

        {sections.map((s) => (
          <View key={s.key} style={styles.section}>
            <View style={styles.sh}>
              <Text style={[styles.shText, { color: colors.foreground }]}>{s.label}</Text>
              <Text style={[styles.shCount, { color: colors.muted }]}>{s.count}</Text>
            </View>
            <View style={[styles.list, { backgroundColor: colors.card, borderRadius: 24, overflow: "hidden" }]}>
              {s.cards.map((card, i) => (
                <QueueRow
                  key={card.id}
                  card={card}
                  onPress={() => router.push(`/reports/${card.id}`)}
                  onLongPress={() => setLpReportId(card.id)}
                  showDivider={i < s.cards.length - 1}
                />
              ))}
            </View>
            {s.note ? <Text style={[styles.sectionNote, { color: colors.muted }]}>{s.note}</Text> : null}
          </View>
        ))}

        <Text style={[styles.note, { color: colors.muted }]}>
          Reports wait at each phase until the agent or a reviewer moves them on.
        </Text>
      </ScrollView>

      <TopBarPill />
      <ReviewFab />

      {lpReportId && (() => {
        const card = cols.flatMap((c) => c.cards).find((c) => c.id === lpReportId)
        const copyLabel = idLabel(card ?? { id: lpReportId, sourceLabel: lpReportId } as QueueCardView)
        return (
          <LongPressMenu
            reportId={copyLabel}
            visible={true}
            onClose={() => setLpReportId(null)}
            onOpenCaseFile={() => {
              setLpReportId(null)
              router.push(`/reports/${lpReportId}`)
            }}
            onCopyId={async () => {
              setLpReportId(null)
              await Clipboard.setStringAsync(copyLabel)
              toast.show("Copied " + copyLabel)
            }}
            onShare={async () => {
              setLpReportId(null)
              await Share.share({ message: `${copyLabel} ${card?.title ?? ""}` })
            }}
          />
        )
      })()}
    </View>
  )
}

export default function QueueScreen() {
  // ToastProvider gives useToast a context so the long-press menu's copy/share/
  // assign actions can surface a toast. Wrapping here (not in _layout.tsx) keeps
  // the change scoped to this file.
  return (
    <ToastProvider>
      <QueueScreenContent />
    </ToastProvider>
  )
}

interface QueueRowProps {
  card: QueueCardView
  onPress: () => void
  onLongPress: () => void
  showDivider: boolean
}

function QueueRow({ card, onPress, onLongPress, showDivider }: QueueRowProps) {
  const { colors, spacing } = useTheme()
  const phase = phaseForCard(card)
  const channelLabel = CHANNEL_LABELS[card.channel] ?? card.channel
  const subtitle = card.targetName ? `${idLabel(card)} · ${card.targetName}` : `${idLabel(card)} · ${channelLabel}`

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={450}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: spacing.itemMinHeight,
          backgroundColor: colors.card,
          paddingLeft: 20,
          opacity: pressed ? 0.92 : 1,
        },
        showDivider && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
      ]}
    >
      <View style={styles.rowMain}>
        <Text style={[styles.itemT, { color: colors.foreground }]} numberOfLines={2}>
          {card.title}
        </Text>
        <Text style={[styles.itemS, { color: colors.muted }]} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <View style={styles.rowR}>
        <PhasePill phase={phase} label={pillLabel(phase)} style={styles.rowPill} />
        {card.investigating ? (
          <Text style={[styles.shimmer, { color: colors.muted }]}>Running</Text>
        ) : (
          <Text style={[styles.itemB, { color: colors.muted }]}>{card.ageLabel}</Text>
        )}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingTop: 8 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontSize: 16 },
  h1: { fontSize: 28, fontWeight: "700", letterSpacing: -0.03 * 28, marginTop: 8, marginBottom: 4 },
  hmeta: { fontSize: 15, marginBottom: 8 },
  section: { marginBottom: 28 },
  sh: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4, paddingVertical: 12 },
  shText: { fontSize: 20, fontWeight: "600", lineHeight: 24 },
  shCount: { marginLeft: 4, fontSize: 20, fontWeight: "600", lineHeight: 24 },
  list: { marginHorizontal: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, paddingHorizontal: 18 },
  rowMain: { flex: 1, minWidth: 0 },
  itemT: { fontSize: 17, fontWeight: "500", lineHeight: 20 },
  itemS: { fontSize: 13, marginTop: 3 },
  rowR: { flexShrink: 0, flexDirection: "column", alignItems: "flex-end", gap: 6 },
  rowPill: { marginTop: 0, marginBottom: 0 },
  itemB: { fontSize: 13 },
  shimmer: { fontSize: 13 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 20, marginTop: 12, marginBottom: 60 },
  sectionNote: { fontSize: 13, lineHeight: 18, paddingHorizontal: 20, marginTop: 8 },
})

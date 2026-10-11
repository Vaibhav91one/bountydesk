/** M4 Home. Needs you carousel, active and delivered report lists.
 * Matches docs/site/screens/m4.html exactly.
 *
 * The tab dock, top bar, and Review FAB are provided by the parent _layout.tsx
 * (the "Variant C" floating tab shell). This screen renders the scrollable content.
 *
 * The section header and phase pills come from the shared primitives so M5 and
 * later screens render the same chrome.
 */
import { useEffect, useState } from "react"
import { View, Text, ScrollView, StyleSheet, Dimensions } from "react-native"

import { api, ApiError } from "@/lib/api"
import { useHandleApiError } from "@/lib/use-api-error"
import type { HomeSummary } from "@/lib/types"
import { useTheme } from "@/theme"
import { Icon } from "@/components/ui/IconButton"
import { PhasePill, SectionHeader, Card } from "@/components/primitives"
import type { PhaseKey } from "@/lib/phases"

const { width: SCREEN_WIDTH } = Dimensions.get("window")
const CARD_WIDTH = SCREEN_WIDTH / 2 - 28

// Mock data matching m4.html exactly (GET /home does not return card rows).
const needsYouCards = [
  {
    id: "BD-1042",
    phase: "approval" as PhaseKey,
    time: "12 min ago",
    title: "Stored XSS in search results",
    subtitle: "BD-1042 · juice-shop v17.3.0",
    severity: "High" as const,
    reproduced: true,
  },
  {
    id: "BD-1044",
    phase: "approval" as PhaseKey,
    time: "34 min ago",
    title: "Missing rate limit on login",
    subtitle: "BD-1044 · juice-shop v17.3.0",
    severity: "Medium" as const,
    reproduced: false,
  },
  {
    id: "BD-1043",
    phase: "approval" as PhaseKey,
    time: "48 min ago",
    title: "Directory listing exposes /ftp",
    subtitle: "BD-1043 · juice-shop v17.3.0",
    severity: "Low" as const,
    reproduced: true,
  },
]

const activeRows: { title: string; subtitle: string; phase: PhaseKey }[] = [
  { title: "SQL injection in login", subtitle: "BD-1041 · juice-shop", phase: "reproducing" },
  { title: "Open redirect on /redirect", subtitle: "BD-1039 · juice-shop", phase: "analysis" },
  { title: "Weak JWT secret", subtitle: "BD-1037 · juice-shop", phase: "triaging" },
]

const deliveredRows: { title: string; subtitle: string; phase: PhaseKey }[] = [
  { title: "Reflected XSS in /search", subtitle: "BD-1033 · juice-shop", phase: "delivered" },
  { title: "CSRF on profile update", subtitle: "BD-1030 · juice-shop", phase: "closed" },
]

const SEV_COLORS = { High: "#EF4444", Medium: "#F59E0B", Low: "#9CA3AF" } as const

export default function HomeScreen() {
  const { colors } = useTheme()
  const [summary, setSummary] = useState<HomeSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const handleApiError = useHandleApiError()

  useEffect(() => {
    api<HomeSummary>("/home")
      .then(setSummary)
      .catch((e: unknown) => {
        handleApiError(e)
        if (e instanceof ApiError) setError(e.message)
      })
  }, [handleApiError])

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={[styles.error, { color: colors.red }]}>{error}</Text>
      </View>
    )
  }

  return (
    <ScrollView
      style={[styles.scroll, { backgroundColor: colors.background }]}
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
        {needsYouCards.map((c) => (
          <NeedYouCard key={c.id} card={c} width={CARD_WIDTH} />
        ))}
      </ScrollView>

      {/* Active section */}
      <View style={styles.section}>
        <SectionHeader title="Active" count={5} onSort={() => {}} />
        <Card style={styles.list}>
          {activeRows.map((r) => (
            <ActiveRow key={r.subtitle} title={r.title} subtitle={r.subtitle} phase={r.phase} />
          ))}
          {/* m4.html: synthetic "2 more in progress" row */}
          <View style={[styles.item, { minHeight: 56 }]}>
            <View style={styles.main}>
              <Text style={[styles.itemS, { fontSize: 15, marginTop: 0, color: colors.muted }]}>2 more in progress</Text>
            </View>
            <Icon name="chev" size={18} stroke={colors.faint} />
          </View>
        </Card>
      </View>

      {/* Delivered section */}
      <View style={styles.section}>
        <SectionHeader title="Delivered" count={2} onSort={() => {}} />
        <Card style={styles.list}>
          {deliveredRows.map((r) => (
            <ActiveRow key={r.subtitle} title={r.title} subtitle={r.subtitle} phase={r.phase} />
          ))}
        </Card>
      </View>

      <Text style={[styles.note, { color: colors.muted }]}>
        Verdicts are only sent after you approve the exact drafted comment.
      </Text>
    </ScrollView>
  )
}

function NeedYouCard({ card, width }: { card: typeof needsYouCards[number]; width: number }) {
  const { colors } = useTheme()
  const sevColor = SEV_COLORS[card.severity as keyof typeof SEV_COLORS]
  return (
    <View style={[styles.ncCard, { width, backgroundColor: colors.card }]}>
      <View style={styles.ncTop}>
        <PhasePill phase={card.phase} style={{ alignSelf: "flex-start" }} />
        <Text style={[styles.ncTime, { color: colors.muted }]}>{card.time}</Text>
      </View>
      <Text style={[styles.ncTitle, { color: colors.foreground }]}>{card.title}</Text>
      <Text style={[styles.ncSubtitle, { color: colors.muted }]}>{card.subtitle}</Text>
      <View style={styles.ncFoot}>
        <Text style={[styles.sev, { color: sevColor }]}>{card.severity}</Text>
        <Text style={[styles.ncStatus, { color: colors.muted }]}>{card.reproduced ? "Reproduced" : "Not reproduced"}</Text>
      </View>
    </View>
  )
}

function ActiveRow({ title, subtitle, phase }: { title: string; subtitle: string; phase: PhaseKey }) {
  const { colors } = useTheme()
  return (
    <View style={styles.item}>
      <View style={styles.main}>
        <Text style={[styles.itemT, { color: colors.foreground }]}>{title}</Text>
        <Text style={[styles.itemS, { color: colors.muted }]}>{subtitle}</Text>
      </View>
      <View style={styles.itemR}>
        <PhasePill phase={phase} style={styles.rowPill} />
        <Text style={[styles.itemB, { color: colors.muted }]}>
          {phase === "triaging" ? "1 h" : phase === "analysis" ? "3 h" : phase === "reproducing" ? "1 h" : "Yesterday"}
        </Text>
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
  ncFoot: { marginTop: "auto", flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(255,255,255,0.08)" },
  sev: { fontSize: 15, fontWeight: "600" },
  ncStatus: { fontSize: 15 },
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

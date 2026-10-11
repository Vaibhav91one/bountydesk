/** M4 Home. Needs you carousel, active and delivered report lists.
 * Matches docs/site/screens/m4.html exactly.
 *
 * The tab dock, top bar, and Review FAB are provided by the parent _layout.tsx
 * (the "Variant C" floating tab shell). This screen renders the scrollable content.
 *
 * OPEN QUESTIONS:
 * - The "2 more in progress" synthetic row in the Active section is hardcoded in m4.html
 *   (not a real report from GET /home). Rendered as-is when the API does not return enough items.
 * - The Needs you carousel shows mock report data from the spec; GET /home does not provide
 *   the individual report cards (title, subtitle, severity, status). Rendered as empty state
 *   if the API response shape differs.
 */
import { useEffect, useState } from "react"
import { View, Text, ScrollView, StyleSheet, Dimensions } from "react-native"

import { api, ApiError } from "@/lib/api"
import { useHandleApiError } from "@/lib/use-api-error"
import type { HomeSummary } from "@/lib/types"
import { darkTheme } from "@/theme"
import { Icon } from "@/components/ui/IconButton"
import { Pill } from "@/components/ui/Pill"

const { width: SCREEN_WIDTH } = Dimensions.get("window")
const CARD_WIDTH = SCREEN_WIDTH / 2 - 28

// Phase pill color map: matches the c.css phase token classes.
const PHASE_INFO: Record<string, { color: string; label: string }> = {
  triaging: { color: darkTheme.phase.triaging, label: "Triaging" },
  reproducing: { color: darkTheme.phase.reproducing, label: "Reproducing" },
  analysis: { color: darkTheme.phase.analysis, label: "Analysis" },
  "awaiting-approval": { color: darkTheme.phase.approval, label: "Awaiting approval" },
  delivered: { color: darkTheme.phase.delivered, label: "Delivered" },
  closed: { color: darkTheme.phase.closed, label: "Closed" },
}

export default function HomeScreen() {
  const [summary, setSummary] = useState<HomeSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const handleApiError = useHandleApiError()

  useEffect(() => {
    api<HomeSummary>("/home")
      .then(setSummary)
      .catch((e: unknown) => {
        handleApiError(e)
        if (e instanceof ApiError) {
          setError(e.message)
        }
      })
  }, [handleApiError])

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{error}</Text>
      </View>
    )
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
    >
      {/* m4.html: h1 Home, hmeta "N total reports N open" */}
      <Text style={styles.h1}>Home</Text>
      <Text style={styles.hmeta}>
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
          <NeedYouCard
            key={c.id}
            id={c.id}
            status={c.status}
            statusColor={c.statusColor}
            time={c.time}
            title={c.title}
            subtitle={c.subtitle}
            severity={c.severity}
            reproduced={c.reproduced}
            width={CARD_WIDTH}
          />
        ))}
      </ScrollView>

      {/* Active section (.list) */}
      <View style={styles.section}>
        <View style={styles.sh}>
          <Text style={styles.shText}>Active</Text>
          <Text style={styles.shCount}>5</Text>
          <Icon name="chev" size={18} stroke={darkTheme.colors.muted} />
        </View>
        <View style={styles.list}>
          <ActiveRow
            title="SQL injection in login"
            subtitle="BD-1041 · juice-shop"
            phase="reproducing"
          />
          <ActiveRow
            title="Open redirect on /redirect"
            subtitle="BD-1039 · juice-shop"
            phase="analysis"
          />
          <ActiveRow
            title="Weak JWT secret"
            subtitle="BD-1037 · juice-shop"
            phase="triaging"
          />
          {/* m4.html: synthetic "2 more in progress" row */}
          <View style={[styles.item, styles.itemVf]}>
            <View style={styles.main}>
              <Text style={[styles.itemS, { fontSize: 15, marginTop: 0 }]}>
                2 more in progress
              </Text>
            </View>
            <Icon name="chev" size={18} stroke={darkTheme.colors.faint} />
          </View>
        </View>
      </View>

      {/* Delivered section (.list) */}
      <View style={styles.section}>
        <View style={styles.sh}>
          <Text style={styles.shText}>Delivered</Text>
          <Text style={styles.shCount}>2</Text>
          <Icon name="chev" size={18} stroke={darkTheme.colors.muted} />
        </View>
        <View style={styles.list}>
          <ActiveRow
            title="Reflected XSS in /search"
            subtitle="BD-1033 · juice-shop"
            phase="delivered"
          />
          <ActiveRow
            title="CSRF on profile update"
            subtitle="BD-1030 · juice-shop"
            phase="closed"
          />
        </View>
      </View>

      {/* Note */}
      <Text style={styles.note}>
        Verdicts are only sent after you approve the exact drafted comment.
      </Text>
    </ScrollView>
  )
}

// Mock data matching m4.html exactly
const needsYouCards = [
  {
    id: "BD-1042",
    status: "Awaiting approval",
    statusColor: darkTheme.phase.approval,
    time: "12 min ago",
    title: "Stored XSS in search results",
    subtitle: "BD-1042 · juice-shop v17.3.0",
    severity: "High" as const,
    reproduced: true,
  },
  {
    id: "BD-1044",
    status: "Awaiting approval",
    statusColor: darkTheme.phase.approval,
    time: "34 min ago",
    title: "Missing rate limit on login",
    subtitle: "BD-1044 · juice-shop v17.3.0",
    severity: "Medium" as const,
    reproduced: false,
  },
  {
    id: "BD-1043",
    status: "Awaiting approval",
    statusColor: darkTheme.phase.approval,
    time: "48 min ago",
    title: "Directory listing exposes /ftp",
    subtitle: "BD-1043 · juice-shop v17.3.0",
    severity: "Low" as const,
    reproduced: true,
  },
]

function NeedYouCard({
  id,
  status,
  statusColor,
  time,
  title,
  subtitle,
  severity,
  reproduced,
  width,
}: {
  id: string
  status: string
  statusColor: string
  time: string
  title: string
  subtitle: string
  severity: "High" | "Medium" | "Low"
  reproduced: boolean
  width: number
}) {
  const sevStyle = {
    High: styles.sevHigh,
    Medium: styles.sevMedium,
    Low: styles.sevLow,
  }[severity]

  return (
    <View style={[styles.ncCard, { width }]}>
      <View style={styles.ncTop}>
        <Pill label={status} color={statusColor} style={styles.pill} />
        <Text style={styles.ncTime}>{time}</Text>
      </View>
      <Text style={styles.ncTitle}>{title}</Text>
      <Text style={styles.ncSubtitle}>{subtitle}</Text>
      <View style={styles.ncFoot}>
        <Text style={[styles.sev, sevStyle]}>{severity}</Text>
        <Text style={styles.ncStatus}>{reproduced ? "Reproduced" : "Not reproduced"}</Text>
      </View>
    </View>
  )
}

function ActiveRow({
  title,
  subtitle,
  phase,
}: {
  title: string
  subtitle: string
  phase: string
}) {
  const { label, color } = PHASE_INFO[phase]

  // In m4.html, reproducing items show a "Running" shimmer.
  const isRunning = phase === "reproducing"

  return (
    <View style={styles.item}>
      <View style={styles.main}>
        <Text style={styles.itemT}>{title}</Text>
        <Text style={styles.itemS}>{subtitle}</Text>
      </View>
      <View style={styles.itemR}>
        <Pill label={label} color={color} style={styles.rowPill} />
        <Text style={styles.itemB}>
          {phase === "triaging" ? "1 h" : phase === "analysis" ? "3 h" : "Yesterday"}
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: darkTheme.colors.background,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontSize: 16, color: darkTheme.colors.red },
  h1: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -1,
    marginTop: 8,
    marginBottom: 4,
    color: darkTheme.colors.foreground,
  },
  hmeta: {
    fontSize: 15,
    color: darkTheme.colors.muted,
    marginBottom: 8,
  },
  // Rail (horizontal carousel)
  rail: {
    gap: 12,
    paddingBottom: 12,
    marginBottom: 4,
  },
  // Carousel card (.nc)
  ncCard: {
    flexShrink: 0,
    backgroundColor: "#131313",
    borderRadius: 24,
    padding: 18,
    gap: 10,
  },
  ncTop: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 4,
  },
  pill: {
    alignSelf: "flex-start",
  },
  ncTime: {
    fontSize: 13,
    color: darkTheme.colors.muted,
  },
  ncTitle: {
    fontSize: 19,
    fontWeight: "600",
    lineHeight: 24,
    letterSpacing: -0.02,
    marginTop: -4,
    color: darkTheme.colors.foreground,
  },
  ncSubtitle: {
    fontSize: 13,
    color: darkTheme.colors.muted,
  },
  ncFoot: {
    marginTop: "auto",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.08)",
  },
  sev: {
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0,
  },
  sevHigh: {
    color: darkTheme.colors.red,
  },
  sevMedium: {
    color: darkTheme.phase.approval,
  },
  sevLow: {
    color: darkTheme.colors.muted,
  },
  ncStatus: {
    fontSize: 15,
    color: darkTheme.colors.muted,
  },
  // Section
  section: {
    marginBottom: 28,
  },
  sh: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingBottom: 12,
  },
  shText: {
    fontSize: 20,
    fontWeight: "600",
    letterSpacing: -0.02,
    color: darkTheme.colors.foreground,
  },
  shCount: {
    fontSize: 15,
    color: darkTheme.colors.muted,
    marginLeft: 2,
  },
  // List
  list: {
    marginHorizontal: 16,
    backgroundColor: "#131313",
    borderRadius: 24,
    overflow: "hidden",
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  itemVf: {},
  main: {
    flex: 1,
    minWidth: 0,
  },
  itemT: {
    fontSize: 17,
    fontWeight: "500",
    lineHeight: 20,
    color: darkTheme.colors.foreground,
  },
  itemS: {
    fontSize: 13,
    color: darkTheme.colors.muted,
    marginTop: 3,
  },
  itemR: {
    flexShrink: 0,
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 6,
  },
  itemB: {
    fontSize: 13,
    color: darkTheme.colors.muted,
    letterSpacing: 0,
  },
  rowPill: {
    marginTop: 0,
    marginBottom: 0,
  },
  // Note
  note: {
    fontSize: 13,
    lineHeight: 18,
    color: darkTheme.colors.muted,
    paddingHorizontal: 20,
    marginTop: 12,
    marginBottom: 60,
  },
})

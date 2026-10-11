/** M4 Home. Phase tile counts from GET /home, with a needs-you count. */
import { useEffect, useState } from "react"
import { View, Text, Dimensions, StyleSheet, ScrollView } from "react-native"
import { LinearGradient } from "expo-linear-gradient"

import { api, ApiError } from "@/lib/api"
import { useHandleApiError } from "@/lib/use-api-error"
import type { HomeSummary } from "@/lib/types"

const CARD_WIDTH = Dimensions.get("window").width / 2 - 28

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

  if (!summary) {
    return (
      <View style={styles.centered}>
        <Text style={styles.loading}>Loading…</Text>
      </View>
    )
  }

  const phaseCards = summary.phases.map((p) => ({
    key: p.key,
    label: p.label,
    count: p.total,
  }))

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <Text style={styles.h1}>Home</Text>
      <Text style={styles.hmeta}>
        {summary.reports} total reports · {summary.open} open
      </Text>

      <View style={styles.grid}>
        <PhaseCard label="Needs you" count={summary.needsYou} accent="#ffb84d" width={CARD_WIDTH} />
        {phaseCards.map((c) => (
          <PhaseCard
            key={c.key}
            label={c.label}
            count={c.count}
            accent={phaseColor(c.key)}
            width={CARD_WIDTH}
          />
        ))}
        <StatCard label="Targets" count={summary.targets} width={CARD_WIDTH} />
        <StatCard label="Decisions" count={summary.decisions} width={CARD_WIDTH} />
      </View>
    </ScrollView>
  )
}

function PhaseCard({
  label,
  count,
  accent,
  width,
}: {
  label: string
  count: number
  accent: string
  width: number
}) {
  return (
    <LinearGradient
      colors={[accent + "20", accent + "10"]}
      style={[styles.card, { width, borderColor: accent + "40" }]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
    >
      <Text style={styles.cardTitle}>{label}</Text>
      <Text style={styles.cardCount}>{count}</Text>
    </LinearGradient>
  )
}

function StatCard({ label, count, width }: { label: string; count: number; width: number }) {
  return (
    <View style={[styles.card, styles.cardDark, { width }]}>
      <Text style={styles.cardTitle}>{label}</Text>
      <Text style={styles.cardCount}>{count}</Text>
    </View>
  )
}

function phaseColor(key: string): string {
  const map: Record<string, string> = {
    triaging: "#7d7dff",
    "analysis-only": "#ff7bce",
    "awaiting-approval": "#e6d04d",
    delivered: "#5cd68a",
    closed: "#888888",
  }
  return map[key] ?? "#888888"
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: "#1a1a1f" },
  container: { padding: 20, gap: 12 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  h1: { fontSize: 28, fontWeight: "700", letterSpacing: -1 },
  hmeta: { fontSize: 15, color: "#919199", marginTop: 4 },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 8,
  },
  card: {
    minHeight: 140,
    borderRadius: 24,
    padding: 18,
    borderWidth: 1,
    justifyContent: "center",
  },
  cardDark: { backgroundColor: "#222228", borderColor: "rgba(255, 255, 255, 0.10)" },
  cardTitle: { fontSize: 15, color: "#b8b8c0", letterSpacing: 0.5 },
  cardCount: { fontSize: 36, fontWeight: "700", marginTop: 6 },
  loading: { fontSize: 17, color: "#919199" },
  error: { fontSize: 16, color: "#ff5b5b" },
})

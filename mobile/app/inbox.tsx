/** M23 Inbox. Needs you and earlier from GET /inbox.
 * Matches docs/site/screens/m23.html exactly.
 *
 * Two sections: "Needs you" (reports awaiting a verdict decision) and "Earlier"
 * (delivered, denied, expired, etc.), newest first. Each row has a title, a
 * subtitle with the report id and state, a phase pill, and a time.
 */
import { View, Text, ScrollView, StyleSheet, Pressable } from "react-native"
import { useRouter } from "expo-router"
import { useApiQuery, ApiError } from "@/lib/use-query"
import type { InboxResponse, InboxCard } from "@/lib/types"
import { useTheme } from "@/theme"
import { ScreenHeader, ScreenTitle, Card, EmptyState } from "@/components/primitives"
import { font } from "@/lib/fonts"

type PhaseColor = "approval" | "delivered" | "closed" | "analysis"

// card.state is the report_lifecycle_state enum, upper case. DELIVERED is only set once the
// transport receipt arrives; DELIVERING is approved and still in flight.
const CLOSED_STATES = new Set(["DENIED", "OUT_OF_SCOPE", "CANCELLED", "EXPIRED"])

function phaseForCard(card: InboxCard): PhaseColor {
  if (card.awaitingVerdictId || card.state === "AWAITING_APPROVAL") return "approval"
  if (card.state === "DELIVERED" || card.state === "DELIVERING") return "delivered"
  if (CLOSED_STATES.has(card.state)) return "closed"
  return "analysis"
}

function phaseColor(theme: ReturnType<typeof useTheme>, phase: PhaseColor): string {
  switch (phase) {
    case "approval": return theme.phase.approval
    case "delivered": return theme.phase.delivered
    case "closed": return theme.phase.closed
    case "analysis": return theme.phase.analysis
  }
}

function phaseLabelFor(phase: PhaseColor, card: InboxCard): string {
  switch (phase) {
    case "approval": return "Approval"
    case "delivered": return card.state === "DELIVERING" ? "Delivering" : "Delivered"
    case "closed": return "Closed"
    case "analysis": return card.state === "ANALYSIS_ONLY" ? "Analysis only" : "Analysis"
  }
}

// Subtitle: the report's short id and where it stands.
function inboxSubtitle(card: InboxCard): string {
  const id = card.sourceLabel
  if (card.awaitingVerdictId || card.state === "AWAITING_APPROVAL") return `${id} · Approval needed`
  if (card.state === "DELIVERED") return `${id} · Delivered`
  if (card.state === "DELIVERING") {
    return card.deliveryState === "FAILED" ? `${id} · Delivery failed, retrying` : `${id} · Waiting for the receipt`
  }
  if (card.state === "ANALYSIS_ONLY") return `${id} · Analysis only`
  return `${id} · ${card.state.replace(/_/g, " ").toLowerCase()}`
}

// Formats the updatedAt timestamp into a relative time string.
function formatTime(updatedAt: string): string {
  const date = new Date(updatedAt)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffHours / 24)

  if (diffHours < 1) return "Just now"
  if (diffHours < 24) return `${diffHours} h`
  return `${diffDays} d`
}

function InboxRow({ card, theme }: { card: InboxCard; theme: ReturnType<typeof useTheme> }) {
  const router = useRouter()
  const phase = phaseForCard(card)
  const col = phaseColor(theme, phase)

  const handlePress = () => {
    if (card.awaitingVerdictId) {
      router.push(`/reports/${card.id}/sign-the-verdict`)
    } else {
      router.push(`/reports/${card.id}`)
    }
  }

  return (
    <Pressable
      onPress={handlePress}
      style={[styles.item, styles.evItem, { backgroundColor: theme.colors.card }]}
    >
      <View style={styles.main}>
        <Text style={[styles.itemT, { color: theme.colors.foreground }]}>{card.title}</Text>
        <Text style={[styles.itemS, { color: theme.colors.muted }]}>{inboxSubtitle(card)}</Text>
      </View>
      <View style={styles.rowTrailing}>
        <View style={[styles.pill, { backgroundColor: col + "29" }]}>
          <View style={[styles.pillDot, { backgroundColor: col }]} />
          <Text style={[styles.pillLabel, { color: col }]}>{phaseLabelFor(phase, card)}</Text>
        </View>
        <Text style={[styles.itemB, { color: theme.colors.muted }]}>{formatTime(card.updatedAt)}</Text>
      </View>
    </Pressable>
  )
}

export default function InboxScreen() {
  const theme = useTheme()
  const router = useRouter()
  const inbox = useApiQuery<InboxResponse>("/inbox")

  const isAuthError = inbox.error instanceof ApiError && (inbox.error.status === 401 || inbox.error.status === 403)
  if (isAuthError) return null
  if (inbox.error) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ color: theme.colors.red, fontFamily: font.regular, fontSize: 16, textAlign: "center" }}>{inbox.error.message}</Text>
      </View>
    )
  }

  const needsYou = inbox.data?.needsYou?.items ?? []
  const earlier = inbox.data?.earlier?.items ?? []

  const needsYouCount = inbox.data?.needsYou?.total ?? needsYou.length

  const { colors } = theme

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader back backLabel="Home" />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        <ScreenTitle title="Inbox" meta={`${needsYouCount} need you`} metaBottom={20} />

        {/* Needs you section */}
        <View style={styles.section}>
          <View style={styles.sh}>
            <Text style={[styles.shText, { color: colors.foreground }]}>Needs you</Text>
          </View>
          {needsYou.length > 0 ? (
            <Card style={styles.list}>
              {needsYou.map((card) => (
                <InboxRow key={card.id} card={card} theme={theme} />
              ))}
            </Card>
          ) : (
            <EmptyState heading="Nothing needs you" body="Verdicts waiting for your approval show up here." inline />
          )}
        </View>

        {/* Earlier section */}
        <View style={styles.section}>
          <View style={styles.sh}>
            <Text style={[styles.shText, { color: colors.foreground }]}>Earlier</Text>
          </View>
          {earlier.length > 0 ? (
            <Card style={styles.list}>
              {earlier.map((card) => (
                <InboxRow key={card.id} card={card} theme={theme} />
              ))}
            </Card>
          ) : null}
          <Text style={[styles.note, { color: colors.muted }]}>
            Delivery is confirmed by a transport receipt, not by the provider accepting a send.
          </Text>
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: {
    paddingTop: 0,
    paddingBottom: 40,
  },
  h1: {
    fontFamily: font.bold, fontSize: 28,
    
    letterSpacing: -0.03 * 28,
    lineHeight: 32,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  hmeta: {
    fontFamily: font.regular, fontSize: 15,
    lineHeight: 20,
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  section: {
    marginBottom: 28,
  },
  sh: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  shText: {
    fontFamily: font.semibold, fontSize: 20,
    
    lineHeight: 24,
  },
  list: {
    marginHorizontal: 16,
    borderRadius: 24,
    overflow: "hidden",
    padding: 0,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  evItem: {
    paddingLeft: 14,
  },
  main: {
    flex: 1,
    minWidth: 0,
  },
  itemT: {
    fontFamily: font.medium, fontSize: 17,
    
    lineHeight: 20,
  },
  itemS: {
    fontFamily: font.regular, fontSize: 13,
    marginTop: 3,
  },
  rowTrailing: {
    paddingLeft: 12,
    paddingRight: 0,
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 6,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 99,
  },
  pillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  pillLabel: {
    fontFamily: font.semibold, fontSize: 13,
    
    lineHeight: 14,
  },
  itemB: {
    fontFamily: font.regular, fontSize: 13,
  },
  note: {
    fontFamily: font.regular, fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 20,
    marginTop: 10,
  },
})

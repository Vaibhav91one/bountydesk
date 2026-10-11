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
import { ScreenHeader, Card } from "@/components/primitives"

type PhaseColor = "approval" | "delivered" | "closed" | "analysis"

// Determines the phase key for a card.
function phaseForCard(card: InboxCard): PhaseColor {
  if (card.awaitingVerdictId) return "approval"
  if (card.deliveryState === "delivered") return "delivered"
  if (card.verdictSuperseded) return "closed"
  return "analysis"
}

// Resolves a phase key to its theme color.
function phaseColor(theme: ReturnType<typeof useTheme>, phase: PhaseColor): string {
  switch (phase) {
    case "approval": return theme.phase.approval
    case "delivered": return theme.phase.delivered
    case "closed": return theme.phase.closed
    case "analysis": return theme.colors.red
  }
}

// Label text for the phase pill.
function phaseLabelFor(phase: PhaseColor, card: InboxCard): string {
  switch (phase) {
    case "approval": return "Approval"
    case "delivered": return "Delivered"
    case "closed": return "Closed"
    case "analysis": return card.state === "analysis_only" ? "Failed" : "Analysis"
  }
}

// Determines the subtitle text based on card state/outcome, matching m23.html.
function inboxSubtitle(card: InboxCard): string {
  if (card.awaitingVerdictId) {
    return `${card.id} · Approval needed`
  }
  if (card.deliveryState === "delivered") {
    return `${card.id} · Delivered`
  }
  if (card.state === "analysis_only" || card.state === "analyzing") {
    return `${card.id} · Target did not start`
  }
  if (card.outcome) {
    return `${card.id} · ${card.outcome}`
  }
  return `${card.id} · ${card.state}`
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

// Mock data matching m23.html when API returns empty/loading.
const mockNeedsYou: InboxCard[] = [
  {
    id: "BD-1042",
    title: "Stored XSS in search results",
    sourceLabel: "GitHub",
    channel: "github",
    targetName: "juice-shop",
    outcome: null,
    verdictSuperseded: false,
    deliveryState: null,
    state: "awaiting_approval",
    awaitingVerdictId: "v-1042",
    updatedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
  },
  {
    id: "BD-1041",
    title: "SQL injection in login",
    sourceLabel: "GitHub",
    channel: "github",
    targetName: "juice-shop",
    outcome: null,
    verdictSuperseded: false,
    deliveryState: null,
    state: "awaiting_approval",
    awaitingVerdictId: "v-1041",
    updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  },
]

const mockEarlier: InboxCard[] = [
  {
    id: "BD-1033",
    title: "Reflected XSS in /search",
    sourceLabel: "GitHub",
    channel: "github",
    targetName: "juice-shop",
    outcome: "delivered",
    verdictSuperseded: false,
    deliveryState: "delivered",
    state: "delivered",
    awaitingVerdictId: null,
    updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "BD-1030",
    title: "CSRF on profile update",
    sourceLabel: "Email",
    channel: "email",
    targetName: null,
    outcome: "delivered",
    verdictSuperseded: false,
    deliveryState: "delivered",
    state: "delivered",
    awaitingVerdictId: null,
    updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "BD-1042",
    title: "Open redirect on /redirect",
    sourceLabel: "Upload",
    channel: "upload",
    targetName: "juice-shop",
    outcome: null,
    verdictSuperseded: false,
    deliveryState: null,
    state: "analysis_only",
    awaitingVerdictId: null,
    updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  },
]

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

  const needsYou = inbox.data?.needsYou?.items ?? []
  const earlier = inbox.data?.earlier?.items ?? []

  const needsYouItems = needsYou.length > 0 ? needsYou : mockNeedsYou
  const earlierItems = earlier.length > 0 ? earlier : mockEarlier
  const needsYouCount = inbox.data?.needsYou?.total ?? 2

  const { colors } = theme

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Inbox" back backLabel="Home" />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        <Text style={[styles.h1, { color: colors.foreground }]}>Inbox</Text>
        <Text style={[styles.hmeta, { color: colors.muted }]}>{needsYouCount} need you</Text>

        {/* Needs you section */}
        <View style={styles.section}>
          <View style={styles.sh}>
            <Text style={[styles.shText, { color: colors.foreground }]}>Needs you</Text>
          </View>
          <Card style={styles.list}>
            {needsYouItems.map((card) => (
              <InboxRow key={card.id} card={card} theme={theme} />
            ))}
          </Card>
        </View>

        {/* Earlier section */}
        <View style={styles.section}>
          <View style={styles.sh}>
            <Text style={[styles.shText, { color: colors.foreground }]}>Earlier</Text>
          </View>
          <Card style={styles.list}>
            {earlierItems.map((card) => (
              <InboxRow key={card.id} card={card} theme={theme} />
            ))}
          </Card>
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
    paddingTop: 62,
    paddingBottom: 40,
  },
  h1: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.03 * 28,
    lineHeight: 32,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  hmeta: {
    fontSize: 15,
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
    fontSize: 20,
    fontWeight: "600",
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
    fontSize: 17,
    fontWeight: "500",
    lineHeight: 20,
  },
  itemS: {
    fontSize: 13,
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
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 14,
  },
  itemB: {
    fontSize: 13,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 20,
    marginTop: 10,
  },
})

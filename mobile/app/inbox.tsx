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
import { ScreenHeader, ScreenTitle, EmptyState, LoadingState } from "@/components/primitives"
import type { PhaseKey } from "@/components/primitives"
import { ListCard, ReportRow, SectionHead } from "@/components/ReportList"
import { BottomFade, Note } from "@/components/CaseUi"
import { ageText } from "@/lib/age"
import { font } from "@/lib/fonts"

// card.state is the report_lifecycle_state enum, upper case. DELIVERED is only set once the
// transport receipt arrives; DELIVERING is approved and still in flight.
const CLOSED_STATES = new Set(["DENIED", "OUT_OF_SCOPE", "CANCELLED", "EXPIRED"])

type Pill = { phase: PhaseKey; label: string; red?: boolean }

function pillForCard(card: InboxCard): Pill {
  if (card.awaitingVerdictId || card.state === "AWAITING_APPROVAL") return { phase: "approval", label: "Approval" }
  if (card.deliveryState === "FAILED") return { phase: "closed", label: "Failed", red: true }
  if (card.state === "DELIVERED" || card.state === "DELIVERING") return { phase: "delivered", label: card.state === "DELIVERING" ? "Delivering" : "Delivered" }
  if (CLOSED_STATES.has(card.state)) return { phase: "closed", label: "Closed" }
  return { phase: "analysis", label: card.state === "ANALYSIS_ONLY" ? "Analysis only" : "Analysis" }
}

// Subtitle: the report's short id and where it stands. A failed row names the reason when the
// server sends one.
function inboxSubtitle(card: InboxCard): string {
  const id = card.sourceLabel
  if (card.awaitingVerdictId || card.state === "AWAITING_APPROVAL") return `${id} · Approval needed`
  if (card.state === "DELIVERED") {
    return `${id} · ${card.channel === "github" ? "Delivered to GitHub" : card.channel === "email" ? "Email delivered" : "Delivered"}`
  }
  if (card.state === "DELIVERING") {
    return card.deliveryState === "FAILED" ? `${id} · Delivery failed, retrying` : `${id} · Waiting for the receipt`
  }
  if (card.deliveryState === "FAILED") return `${id} · ${card.failureReason ?? "Delivery failed"}`
  if (card.state === "ANALYSIS_ONLY") return `${id} · Analysis only`
  return `${id} · ${card.state.replace(/_/g, " ").toLowerCase()}`
}

function InboxRow({ card, divider }: { card: InboxCard; divider: boolean }) {
  const router = useRouter()
  const { colors } = useTheme()
  const pill = pillForCard(card)
  return (
    <ReportRow
      divider={divider}
      title={card.title}
      subtitle={inboxSubtitle(card)}
      phase={pill.phase}
      pillLabel={pill.label}
      pillColor={pill.red ? colors.red : undefined}
      age={ageText(card.updatedAt)}
      onPress={() => router.push(card.awaitingVerdictId ? `/reports/${card.id}/sign-the-verdict` : `/reports/${card.id}`)}
    />
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

        <View style={styles.sect}>
          <SectionHead title="Needs you" />
          {inbox.isLoading ? (
            <LoadingState label="Loading inbox" inline />
          ) : needsYou.length > 0 ? (
            <ListCard>
              {needsYou.map((card, i) => (
                <InboxRow key={card.id} card={card} divider={i > 0} />
              ))}
            </ListCard>
          ) : (
            <EmptyState heading="Nothing needs you" body="Verdicts waiting for your approval show up here." inline />
          )}
        </View>

        <View style={styles.sect}>
          <SectionHead title="Earlier" />
          {earlier.length > 0 ? (
            <ListCard>
              {earlier.map((card, i) => (
                <InboxRow key={card.id} card={card} divider={i > 0} />
              ))}
            </ListCard>
          ) : null}
          <Note>Delivery is confirmed by a transport receipt, not by the provider accepting a send.</Note>
        </View>
      </ScrollView>
      <BottomFade />
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 150 },
  sect: { marginBottom: 28 },
})

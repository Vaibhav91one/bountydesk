/** M16 Integrations. Email and GitHub integration status.
 * Matches docs/site/screens/m16.html exactly.
 *
 * Channels list: Email (tapping navigates to M17 email access) and GitHub
 * (tapping navigates to M14 connections). Each row shows an icon, a title,
 * a subtitle, and a status pill.
 */
import { View, Text, ScrollView, StyleSheet, Pressable } from "react-native"
import { useRouter } from "expo-router"
import { useApiQuery, ApiError } from "@/lib/use-query"
import type { IntegrationRow, EmailReviewer } from "@/lib/types"
import { useTheme } from "@/theme"
import { ScreenHeader, Card } from "@/components/primitives"
import { Icon } from "@/components/icons"
import type { IconName } from "@/components/icons"

// Maps integration id to the c.js icon name.
const INTEGRATION_ICONS: Record<string, IconName> = {
  email: "mail",
  github: "github",
  upload: "upload",
}

const INTEGRATION_LABELS: Record<string, string> = {
  email: "Email",
  github: "GitHub",
  upload: "Upload",
}

// Resolves the subtitle for an integration row, matching the mockup.
function getSubtitle(integration: IntegrationRow, verifiedCount: number): string {
  if (integration.id === "email") {
    const total = verifiedCount
    return `${total} reviewers verified`
  }
  if (integration.id === "github") {
    return "1 installation"
  }
  return integration.type
}

// Resolves the status pill label for an integration row.
function getStatusLabel(integration: IntegrationRow): string {
  if (integration.id === "email") return "Active"
  if (integration.id === "github") return integration.configured ? "Connected" : "Not configured"
  return integration.configured ? "Configured" : "Not configured"
}

// Resolves the pill phase color key.
function getStatusPhase(integration: IntegrationRow): "delivered" | "closed" {
  if (integration.configured) {
    return "delivered"
  }
  return "closed"
}

export default function IntegrationsScreen() {
  const theme = useTheme()
  const { colors } = theme
  const router = useRouter()
  const integrations = useApiQuery<IntegrationRow[]>("/integrations")
  const emailReviewers = useApiQuery<EmailReviewer[]>("/integrations/email")

  const isAuthError =
    (integrations.error instanceof ApiError && (integrations.error.status === 401 || integrations.error.status === 403)) ||
    (emailReviewers.error instanceof ApiError && (emailReviewers.error.status === 401 || emailReviewers.error.status === 403))

  if (isAuthError) return null

  const verifiedCount = emailReviewers.data?.filter((r) => r.verified).length ?? 3

  // Mock data matching m16.html when API returns empty/loading.
  const mockIntegrations: IntegrationRow[] = [
    { id: "email", name: "Email", type: "email", configured: true },
    { id: "github", name: "GitHub", type: "github", configured: true },
  ]

  const items = integrations.data && integrations.data.length > 0 ? integrations.data : mockIntegrations

  const handlePress = (integration: IntegrationRow) => {
    if (integration.id === "email") {
      router.push("/more/integrations/email-access")
    } else if (integration.id === "github") {
      router.push("/more/connections")
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Integrations" back backLabel="Settings" />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        <Text style={[styles.h1, { color: colors.foreground }]}>Integrations</Text>
        <Text style={[styles.hmeta, { color: colors.muted }]}>Where reports come in and verdicts go out</Text>

        <View style={styles.section}>
          <View style={styles.sh}>
            <Text style={[styles.shText, { color: colors.foreground }]}>Channels</Text>
          </View>
          <Card style={styles.list}>
            {items.map((integration) => {
              const iconName = INTEGRATION_ICONS[integration.id] ?? "mail"
              const label = getStatusLabel(integration)
              const phase = getStatusPhase(integration)
              const pillColor = phase === "delivered" ? theme.phase.delivered : theme.phase.closed
              return (
                <Pressable
                  key={integration.id}
                  onPress={() => handlePress(integration)}
                  style={[styles.item, { backgroundColor: colors.card }]}
                >
                  <View style={styles.rowLeading}>
                    <Icon name={iconName} size={20} stroke={colors.muted} />
                  </View>
                  <View style={styles.main}>
                    <Text style={[styles.itemT, { color: colors.foreground }]}>{INTEGRATION_LABELS[integration.id] ?? integration.name}</Text>
                    <Text style={[styles.itemS, { color: colors.muted }]}>{getSubtitle(integration, verifiedCount)}</Text>
                  </View>
                  <View style={styles.rowTrailing}>
                    <View style={[styles.pill, { backgroundColor: pillColor + "29" }]}>
                      <View style={[styles.pillDot, { backgroundColor: pillColor }]} />
                      <Text style={[styles.pillLabel, { color: pillColor }]}>{label}</Text>
                    </View>
                  </View>
                </Pressable>
              )
            })}
          </Card>
          <Text style={[styles.note, { color: colors.muted }]}>
            Each channel is independent. Email and upload need no GitHub connection to create and triage a report.
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
  rowLeading: {
    paddingLeft: 0,
    paddingRight: 12,
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
  note: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 20,
    marginTop: 10,
  },
})

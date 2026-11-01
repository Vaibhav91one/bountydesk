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
import { ScreenHeader, ScreenTitle, PhasePill, EmptyState, LoadingState } from "@/components/primitives"
import { Icon } from "@/components/icons"
import type { IconName } from "@/components/icons"
import { ListCard, SectionHead } from "@/components/ReportList"
import { BottomFade, ItemLine, Note } from "@/components/CaseUi"
import { font } from "@/lib/fonts"

// Maps integration id to the c.js icon name.
const INTEGRATION_ICONS: Record<string, IconName> = {
  email: "mail",
  github: "github",
  upload: "upload",
}

// The status pill is design copy per channel; the server's action label is a link caption ("Manage").
const STATUS_LABELS: Record<string, string> = { email: "Active", github: "Connected" }

const INTEGRATION_LABELS: Record<string, string> = {
  email: "Email",
  github: "GitHub",
  upload: "Upload",
}

export default function IntegrationsScreen() {
  const { colors } = useTheme()
  const router = useRouter()
  const integrations = useApiQuery<IntegrationRow[]>("/integrations")
  const emailReviewers = useApiQuery<EmailReviewer[]>("/integrations/email")

  const isAuthError =
    (integrations.error instanceof ApiError && (integrations.error.status === 401 || integrations.error.status === 403)) ||
    (emailReviewers.error instanceof ApiError && (emailReviewers.error.status === 401 || emailReviewers.error.status === 403))

  if (isAuthError) return null
  if (integrations.error) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ color: colors.red, fontFamily: font.regular, fontSize: 16, textAlign: "center" }}>{integrations.error.message}</Text>
      </View>
    )
  }

  const items = integrations.data ?? []
  const verifiedCount = emailReviewers.data?.filter((r) => r.verified).length

  // The email row's subtitle counts verified reviewers when the list has loaded; every other row
  // uses the server's own detail line.
  const subtitle = (integration: IntegrationRow) =>
    integration.id === "email" && verifiedCount !== undefined
      ? `${verifiedCount} ${verifiedCount === 1 ? "reviewer" : "reviewers"} verified`
      : integration.detail

  const handlePress = (integration: IntegrationRow) => {
    if (integration.id === "email") {
      router.push("/more/integrations/email-access")
    } else if (integration.id === "github") {
      router.push("/more/connections")
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader back backLabel="Settings" />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        <ScreenTitle title="Integrations" meta="Where reports come in and verdicts go out" metaBottom={24} />

        <SectionHead title="Channels" />
        {integrations.isLoading ? (
          <LoadingState label="Loading channels" inline />
        ) : items.length === 0 ? (
          <EmptyState mascot="greeting" heading="No channels yet" body="Channels appear here once they are available." inline />
        ) : (
        <ListCard>
          {items.map((integration, i) => (
            <Pressable key={integration.id} onPress={() => handlePress(integration)} accessibilityRole="button" accessibilityLabel={INTEGRATION_LABELS[integration.id] ?? integration.name}>
              <ItemLine
                divider={i > 0}
                title={INTEGRATION_LABELS[integration.id] ?? integration.name}
                subtitle={subtitle(integration)}
                leading={
                  <View style={[styles.avatar, { backgroundColor: colors.brand + "38" }]}>
                    <Icon name={INTEGRATION_ICONS[integration.id] ?? "mail"} size={20} stroke={colors["brand-soft"]} />
                  </View>
                }
                trailing={<PhasePill phase={integration.installed ? "delivered" : "closed"} label={integration.installed ? (STATUS_LABELS[integration.id] ?? "Connected") : "Not configured"} />}
              />
            </Pressable>
          ))}
        </ListCard>
        )}
        <Note>Each channel is independent. Email and upload need no GitHub connection to create and triage a report.</Note>
      </ScrollView>
      <BottomFade />
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 150 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
})

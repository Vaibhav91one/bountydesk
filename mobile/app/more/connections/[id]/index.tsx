/** M15 Connection detail. Detail view for a GitHub App connection.
 *
 * The screen reads its id from the route param and fetches the connections list
 * from GET /api/mobile/v1/connections, then finds the matching row by repoId.
 * M22 (target-and-scope) is opened from a report, not from here, so this screen
 * shows the bound target inline as a plain KvRow.
 */
import { View, Text, ScrollView, StyleSheet, Pressable } from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"

import { useApiQuery, ApiError } from "@/lib/use-query"
import type { ConnectionRow } from "@/lib/types"
import { useTheme } from "@/theme"
import { Icon } from "@/components/icons"
import { Card, KvRow, SectionHeader, ScreenHeader, EmptyState, ScreenTitle } from "@/components/primitives"
import { font } from "@/lib/fonts"

// Fixed by the GitHub App's least-privilege scope described in docs/mobile-api.md:
function grant(value: string | null): string {
  if (value === "write") return "Read and write"
  if (value === "read") return "Read"
  return "Not granted"
}

// Metadata and Issues are the App's fixed least privilege; the other two are what the
// installation owner has actually accepted.
function permissions(row: ConnectionRow): { key: string; value: string }[] {
  return [
    { key: "Metadata", value: "Read" },
    { key: "Issues", value: "Read and write" },
    { key: "Security advisories", value: grant(row.advisoriesPermission) },
    { key: "Contents", value: grant(row.contentsPermission) },
  ]
}

export default function ConnectionDetailScreen() {
  const { colors } = useTheme()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { data: rows, error } = useApiQuery<ConnectionRow[]>("/connections")
  const router = useRouter()

  const isAuthError = error instanceof ApiError && (error.status === 401 || error.status === 403)
  if (error && !isAuthError) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.error, { color: colors.red }]}>{error.message}</Text>
      </View>
    )
  }

  if (error) return null

  const row = rows ? rows.find((r) => String(r.repoId) === String(id)) : null

  if (!row) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader back backLabel="Connections" />
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.scrollContent, { alignItems: "center" }]}
          showsVerticalScrollIndicator={false}
        >
          <EmptyState
            heading="Connection not found"
            inline
          />
        </ScrollView>
      </View>
    )
  }

  const visibility = row.isPrivate ? "Private" : "Public"
  // A private repo clones only with Contents read accepted; without it reproduction is POLICY_REFUSED.
  const clone = !row.isPrivate
    ? "Anonymous"
    : row.contentsPermission === "read" || row.contentsPermission === "write"
      ? "Installation token (Contents read)"
      : "Blocked: Contents not granted"
  const bound = row.configured
  const digest = row.target

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader back backLabel="Connections" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <ScreenTitle title={row.name} meta={row.fullName} metaBottom={24} />

        {/* Repository */}
        <SectionHeader title="Repository" chevron={false} />
        <Card style={styles.card}>
          <KvRow label="Visibility" value={visibility} />
          <KvRow label="Clone" value={clone} />
        </Card>

        {/* Granted permissions */}
        <SectionHeader title="Granted permissions" chevron={false} />
        <Card style={styles.card}>
          {permissions(row).map((p) => (
            <KvRow key={p.key} label={p.key} value={p.value} />
          ))}
        </Card>
        <Text style={[styles.note, { color: colors.muted }]}>Contents is only needed for private repositories.</Text>

        {/* Onboarding — navigates to the M27 onboarding screen for this repo. */}
        <SectionHeader title="Onboarding" chevron={false} />
        <Card style={styles.card}>
          <Pressable
            onPress={() => router.push(`/more/connections/${row.repoId}/onboarding`)}
            style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}
            accessibilityLabel="View onboarding"
            testID="onboarding-row"
          >
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16, minHeight: 56, paddingHorizontal: 18 }}>
              <Text style={{ fontFamily: font.medium, fontSize: 17, color: colors.foreground }}>Onboarding</Text>
              <Icon name="chev" size={18} stroke={colors.faint} />
            </View>
          </Pressable>
        </Card>

        {/* Bound target — shown inline as a plain KvRow, no press-through. */}
        <SectionHeader title="Bound target" chevron={false} />
        <Card style={styles.card}>
          <KvRow
            label="Target"
            value={bound && digest ? digest : "Not set"}
          />
        </Card>
        <Text style={[styles.note, { color: colors.muted }]}>The target is held on the server. The agent cannot change it.</Text>

        {/* Private repository policy */}
        <SectionHeader title="Private repository policy" chevron={false} />
        <Card style={styles.policyCard}>
          <Text style={[styles.body, { color: colors.foreground }]}>
            A private repository is accepted and triaged. Reproduction is refused with
            <Text style={[styles.code, { color: colors["brand-soft"] }]}> POLICY_REFUSED </Text>
            until Contents read is added and the owner accepts it. The clone uses a token
            scoped to that one repository, revoked right after.
          </Text>
        </Card>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { paddingTop: 0, paddingBottom: 100 },
  h1: { fontFamily: font.bold, fontSize: 28, letterSpacing: -0.03 * 28, lineHeight: 32, paddingHorizontal: 20, paddingTop: 16 },
  hmeta: { fontFamily: font.regular, fontSize: 15, lineHeight: 20, paddingHorizontal: 20, marginBottom: 12 },
  card: { marginHorizontal: 16, borderRadius: 24, overflow: "hidden", marginBottom: 4 },
  policyCard: { marginHorizontal: 16, borderRadius: 24, overflow: "hidden", marginBottom: 4 },
  note: { fontFamily: font.regular, fontSize: 13, lineHeight: 18, paddingHorizontal: 20, marginTop: 10, marginBottom: 12 },
  body: { fontFamily: font.regular, fontSize: 17, lineHeight: 24, paddingHorizontal: 20, paddingTop: 16 },
  code: { fontFamily: font.mono, fontSize: 13 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontFamily: font.regular, fontSize: 16 },
})

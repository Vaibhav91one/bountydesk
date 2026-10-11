/** M15 Connection detail. Detail view for a GitHub App connection.
 *
 * The screen reads its id from the route param and fetches the connections list
 * from GET /api/mobile/v1/connections, then finds the matching row by repoId.
 * M22 (target-and-scope) is opened from a report, not from here, so this screen
 * shows the bound target inline as a plain KvRow.
 */
import { View, Text, ScrollView, StyleSheet } from "react-native"
import { useLocalSearchParams } from "expo-router"

import { useApiQuery, ApiError } from "@/lib/use-query"
import type { ConnectionRow } from "@/lib/types"
import { useTheme } from "@/theme"
import { Card, KvRow, SectionHeader, ScreenHeader, EmptyState } from "@/components/primitives"

// Fixed by the GitHub App's least-privilege scope described in docs/mobile-api.md:
// Metadata read, Issues read+write, Security advisories read+write.
const PERMISSIONS = [
  { key: "Metadata", value: "Read" },
  { key: "Issues", value: "Read and write" },
  { key: "Security advisories", value: "Read and write" },
  { key: "Contents", value: "Not granted" },
]

export default function ConnectionDetailScreen() {
  const { colors } = useTheme()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { data: rows, error } = useApiQuery<ConnectionRow[]>("/connections")

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
        <ScreenHeader title="" back backLabel="Connections" />
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
  const clone = row.isPrivate ? "Installation token (Contents read)" : "Anonymous"
  const bound = row.configured
  const digest = row.target

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title={row.name} back backLabel="Connections" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.h1, { color: colors.foreground }]}>{row.name}</Text>
        <Text style={[styles.hmeta, { color: colors.muted }]}>{row.fullName}</Text>

        {/* Repository */}
        <SectionHeader title="Repository" chevron={false} />
        <Card style={styles.card}>
          <KvRow label="Visibility" value={visibility} />
          <KvRow label="Clone" value={clone} />
        </Card>

        {/* Granted permissions */}
        <SectionHeader title="Granted permissions" chevron={false} />
        <Card style={styles.card}>
          {PERMISSIONS.map((p) => (
            <KvRow key={p.key} label={p.key} value={p.value} />
          ))}
        </Card>
        <Text style={[styles.note, { color: colors.muted }]}>Contents is only needed for private repositories.</Text>

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
  scrollContent: { paddingTop: 6, paddingBottom: 100 },
  h1: { fontSize: 28, fontWeight: "700", letterSpacing: -0.03 * 28, lineHeight: 32, paddingHorizontal: 20, paddingTop: 16 },
  hmeta: { fontSize: 15, lineHeight: 20, paddingHorizontal: 20, marginBottom: 12 },
  card: { marginHorizontal: 16, borderRadius: 24, overflow: "hidden", marginBottom: 4 },
  policyCard: { marginHorizontal: 16, borderRadius: 24, overflow: "hidden", marginBottom: 4 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 20, marginTop: 10, marginBottom: 12 },
  body: { fontSize: 17, lineHeight: 24, paddingHorizontal: 20, paddingTop: 16 },
  code: { fontFamily: "GeistMono", fontSize: 13 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontSize: 16 },
})

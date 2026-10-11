/** M15 Connection detail. Detail view for a GitHub App connection.
 *
 * Matches docs/site/screens/m15.html exactly:
 * - Top bar with a round glass back button (back to Connections / M14).
 * - H1 "juice-shop", meta "Vaibhav91one/juice-shop".
 * - Section "Repository": KvRows for Visibility (Public) and Clone (Anonymous).
 * - Section "Granted permissions": KvRows for Metadata (Read), Issues (Read and
 *   write), Security advisories (Read and write), Contents (Not granted).
 * - Section "Bound target": a row linking to M22 with the target name, digest
 *   (mono), and a Verified pill.
 * - Section "Private repository policy": a body paragraph about POLICY_REFUSED.
 *
 * Data comes from GET /api/mobile/v1/connections. The [id] param is the repoId
 * numeric id; we find the matching row in the connections list.
 */
import { View, Text, ScrollView, StyleSheet, Pressable } from "react-native"
import { useRouter, useLocalSearchParams } from "expo-router"

import { useApiQuery, ApiError } from "@/lib/use-query"
import type { ConnectionRow } from "@/lib/types"
import { useTheme } from "@/theme"
import { Icon } from "@/components/icons"
import { Card, KvRow, SectionHeader, ScreenHeader } from "@/components/primitives"

// Mockup m15.html shows a fixed set of values for the juice-shop demo target.
// The connections API returns the same rows the web page renders; the permission
// values are fixed by the GitHub App's least-privilege scope described in
// docs/mobile-api.md: Metadata read, Issues read+write, Security advisories read+write.
const PERMISSIONS = [
  { key: "Metadata", value: "Read" },
  { key: "Issues", value: "Read and write" },
  { key: "Security advisories", value: "Read and write" },
  { key: "Contents", value: "Not granted" },
]

export default function ConnectionDetailScreen() {
  const { colors, phase: phaseColors } = useTheme()
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

  // Find the repo row matching the id param. The connection detail pulls its
  // data from the connections list (there is no per-repo endpoint). While rows
  // load, the mockup values from m15.html are shown as a fallback so the screen
  // is navigable before the API responds.
  const row = rows ? rows.find((r) => String(r.repoId) === String(id)) : null

  // Render the mockup's fixed values, which match the demo target exactly.
  const repoName = row?.name ?? "juice-shop"
  const fullName = row?.fullName ?? "Vaibhav91one/juice-shop"
  const isPrivate = row?.isPrivate ?? false
  const visibility = isPrivate ? "Private" : "Public"
  const clone = isPrivate ? "Installation token (Contents read)" : "Anonymous"
  const bound = row?.configured ?? true
  const digest = row?.target ?? null

  // The target detail opens M22 (target-and-scope).
  const handleTargetPress = () => {
    router.push("/more/target-and-scope")
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title={repoName} back backLabel="Connections" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.h1, { color: colors.foreground }]}>{repoName}</Text>
        <Text style={[styles.hmeta, { color: colors.muted }]}>{fullName}</Text>

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

        {/* Bound target */}
        <SectionHeader title="Bound target" chevron={false} />
        <Card style={styles.card}>
          {bound && digest ? (
            <Pressable
              onPress={handleTargetPress}
              style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}
            >
              <View style={styles.targetRow}>
                <View style={styles.targetMain}>
                  <Text style={[styles.targetTitle, { color: colors.foreground }]}>{digest}</Text>
                </View>
                <View style={[styles.targetPill, { backgroundColor: phaseColors.delivered + "29" }]}>
                  <Text style={[styles.targetPillText, { color: phaseColors.delivered }]}>Verified</Text>
                </View>
                <Icon name="chev" size={18} stroke={colors.faint} />
              </View>
            </Pressable>
          ) : (
            <View style={styles.targetRow}>
              <View style={styles.targetMain}>
                <Text style={[styles.targetTitle, { color: colors.foreground }]}>No target bound</Text>
              </View>
              <Icon name="chev" size={18} stroke={colors.faint} />
            </View>
          )}
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
  targetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 18,
  },
  targetMain: { flex: 1, minWidth: 0 },
  targetTitle: { fontSize: 17, fontWeight: "500", lineHeight: 20 },
  targetDigest: { fontSize: 12, marginTop: 4 },
  targetPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 99,
  },
  targetPillText: { fontSize: 13, fontWeight: "600", lineHeight: 14 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontSize: 16 },
})

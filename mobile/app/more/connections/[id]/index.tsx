/** M15 Connection detail. Detail view for a GitHub App connection.
 *
 * The screen reads its id from the route param and fetches the connections list
 * from GET /api/mobile/v1/connections, then finds the matching row by repoId.
 * The bound-target row opens the repository's onboarding (M27); M22 is per report
 * and is opened from a report, not from here.
 */
import { View, Text, ScrollView, StyleSheet, Pressable } from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"

import { useApiQuery, ApiError } from "@/lib/use-query"
import type { ConnectionRow } from "@/lib/types"
import { useTheme } from "@/theme"
import { Icon } from "@/components/icons"
import { PhasePill, ScreenHeader, ScreenTitle, EmptyState } from "@/components/primitives"
import { ListCard, SectionHead } from "@/components/ReportList"
import { BottomFade, ItemLine, KvLine, Note } from "@/components/CaseUi"
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

  // While the list is still loading there is no row to find yet, so show the chrome only.
  if (!rows) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }} testID="connection-loading">
        <ScreenHeader back backLabel="Connections" />
      </View>
    )
  }

  const row = rows.find((r) => String(r.repoId) === String(id))

  if (!row) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader back backLabel="Connections" />
        <ScrollView style={styles.scroll} contentContainerStyle={[styles.scrollContent, { alignItems: "center" }]} showsVerticalScrollIndicator={false}>
          <EmptyState heading="Connection not found" inline />
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
  const bound = row.configured && !!row.target
  const detail = row.onboardingDetail
  const title = bound ? [row.target, detail?.buildMarker].filter(Boolean).join(" · ") : "Not set"
  const digest = detail?.imageDigest ?? row.onboarding?.imageDigest ?? undefined

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader back backLabel="Connections" />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <ScreenTitle title={row.name} meta={row.fullName} metaBottom={24} />

        <View style={styles.sect}>
          <SectionHead title="Repository" />
          <ListCard>
            <KvLine label="Visibility" value={visibility} />
            <KvLine label="Clone" value={clone} divider />
          </ListCard>
        </View>

        <View style={styles.sect}>
          <SectionHead title="Granted permissions" />
          <ListCard>
            {permissions(row).map((p, i) => (
              <KvLine key={p.key} label={p.key} value={p.value} divider={i > 0} />
            ))}
          </ListCard>
          <Note>Contents is only needed for private repositories.</Note>
        </View>

        <View style={styles.sect}>
          <SectionHead title="Bound target" />
          <ListCard>
            <Pressable
              onPress={() => router.push(`/more/connections/${row.repoId}/onboarding`)}
              style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}
              accessibilityLabel="View onboarding"
              testID="onboarding-row"
            >
              <ItemLine
                title={title}
                subtitle={bound ? digest : undefined}
                monoSubtitle
                trailing={
                  <>
                    {bound ? <PhasePill phase="delivered" label="Verified" /> : null}
                    <Icon name="chev" size={18} stroke={colors.faint} />
                  </>
                }
              />
            </Pressable>
          </ListCard>
          <Note>The target is held on the server. The agent cannot change it.</Note>
        </View>

        <View style={styles.sect}>
          <SectionHead title="Private repository policy" />
          <ListCard flush>
            <Text style={[styles.body, { color: colors.foreground }]}>
              A private repository is accepted and triaged. Reproduction is refused with{" "}
              <Text style={[styles.code, { color: colors["brand-soft"] }]}>POLICY_REFUSED</Text>
              {" "}until Contents read is added and the owner accepts it. The clone uses a token
              scoped to that one repository, revoked right after.
            </Text>
          </ListCard>
        </View>
      </ScrollView>
      <BottomFade />
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 150 },
  sect: { marginBottom: 28 },
  body: { fontFamily: font.regular, fontSize: 17, lineHeight: 25.5, letterSpacing: -0.187, paddingVertical: 16, paddingHorizontal: 18 },
  code: { fontFamily: font.mono, fontSize: 14.5 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontFamily: font.regular, fontSize: 16 },
})

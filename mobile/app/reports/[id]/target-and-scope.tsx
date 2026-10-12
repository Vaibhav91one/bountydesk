/** M22 Target and scope. Show the bound reproduction target and its scope rules.
 *
 * The screen reads its report id from the route param and fetches the case file
 * from GET /api/mobile/v1/reports/[id]. The meta line is built from the target
 * name and the short digest. When targetScope is null there is no bound target,
 * so the screen shows an empty state instead of demo data.
 */
import { View, Text, ScrollView, StyleSheet } from "react-native"
import { useLocalSearchParams } from "expo-router"
import { useApiQuery, ApiError } from "@/lib/use-query"
import type { MobileCaseFileWithScope } from "@/lib/types"
import { useTheme } from "@/theme"
import { Card, KvRow, SectionHeader, ScreenHeader, Mono, EmptyState, ScreenTitle } from "@/components/primitives"
import { font } from "@/lib/fonts"

// Keep the digest readable in the header meta.
function shortDigest(digest: string): string {
  if (digest.startsWith("sha256:")) return digest.slice("sha256:".length, "sha256:".length + 12)
  return digest.slice(0, 12)
}

function ruleValue(entry: unknown): string {
  if (entry && typeof entry === "object" && "allow" in entry && typeof (entry as any).allow === "string") {
    return (entry as any).allow
  }
  return JSON.stringify(entry)
}

export default function TargetAndScopeScreen() {
  const { colors, phase: phaseColors } = useTheme()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { data: caseFile, error } = useApiQuery<MobileCaseFileWithScope>(`/reports/${id}`)

  const isAuthError = error instanceof ApiError && (error.status === 401 || error.status === 403)
  if (error && !isAuthError) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.error, { color: colors.red }]}>{error.message}</Text>
      </View>
    )
  }

  if (error) return null

  const target = caseFile?.target ?? null
  const scope = caseFile?.targetScope

  if (!scope) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader back backLabel="Case file" />
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <ScreenTitle title="Target and scope" />
          <EmptyState
            heading="No bound target"
            body="This report has no authorised target, so nothing was reproduced."
            inline
          />
        </ScrollView>
      </View>
    )
  }

  const digest = target?.imageDigest ?? scope.imageDigest
  const meta = target ? `${target.name} · ${shortDigest(digest)}` : shortDigest(digest)

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader back backLabel="Case file" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <ScreenTitle title="Target and scope" meta={meta} metaBottom={20} />

        {/* Pinned image */}
        <SectionHeader title="Pinned image" chevron={false} />
        <Card style={styles.card}>
          <KvRow
            label="Image digest"
            value={
              <Mono style={{ color: colors.foreground }}>
                {scope.imageDigest}
              </Mono>
            }
          />
          {scope.snapshotId ? (
            <KvRow
              label="Snapshot id"
              value={
                <Mono style={{ color: colors.foreground }}>
                  {scope.snapshotId}
                </Mono>
              }
            />
          ) : null}
          {scope.buildMarker ? (
            <KvRow
              label="Build"
              value={
                <Mono style={{ color: colors.foreground }}>
                  {scope.buildMarker}
                </Mono>
              }
            />
          ) : null}
        </Card>

        {/* Scope rules */}
        <SectionHeader title="Scope rules" chevron={false} />
        <Card style={styles.card}>
          {(scope.scopeRules ?? []).map((entry, i) => (
            <KvRow key={i} label="Allow" value={ruleValue(entry)} />
          ))}
          <KvRow label="Egress" value={scope.egress === "none" ? "None" : scope.egress} />
        </Card>
        <Text style={[styles.note, { color: colors.muted }]}>
          Reproduction runs offline in a sandbox. The only network the agent can reach is the target.
        </Text>

        {/* Readiness */}
        <SectionHeader title="Readiness" chevron={false} />
        <Card style={styles.card}>
          <View style={styles.readinessRow}>
            <View style={styles.readinessMain}>
              <Text style={[styles.readinessTitle, { color: colors.foreground }]}>Health check</Text>
              <Text style={[styles.readinessSubtitle, { color: colors.muted }]}>
                Readiness check at {scope.readinessPath}
              </Text>
              {scope.startCommand ? (
                <Text style={[styles.readinessStart, { color: colors.muted }]}>
                  Start: {scope.startCommand}
                </Text>
              ) : null}
            </View>
            <View style={[styles.readyPill, { backgroundColor: phaseColors.delivered + "29" }]}>
              <Text style={[styles.readyPillText, { color: phaseColors.delivered }]}>Ready</Text>
            </View>
          </View>
        </Card>
        <Text style={[styles.note, { color: colors.muted }]}>
          This profile is held on the server. The agent cannot change it, scope is never taken from
          agent text, and a sandbox status file reports readiness only.
        </Text>
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
  note: { fontFamily: font.regular, fontSize: 13, lineHeight: 18, paddingHorizontal: 20, marginTop: 10 },
  readinessRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 18,
  },
  readinessMain: { flex: 1, minWidth: 0 },
  readinessTitle: { fontFamily: font.medium, fontSize: 17, lineHeight: 20 },
  readinessSubtitle: { fontFamily: font.regular, fontSize: 13, marginTop: 3 },
  readinessStart: { fontFamily: font.regular, fontSize: 13, marginTop: 3 },
  readyPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 99,
  },
  readyPillText: { fontFamily: font.semibold, fontSize: 13, lineHeight: 14 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontFamily: font.regular, fontSize: 16 },
})

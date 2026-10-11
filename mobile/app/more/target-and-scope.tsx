/** M22 Target and scope. Show the bound reproduction target and its scope rules.
 *
 * Matches docs/site/screens/m22.html exactly:
 * - Top bar with a round glass back button (back to Case file / M7).
 * - H1 "Target and scope", meta "juice-shop · v17.3.0 · 1867b92".
 * - Section "Pinned image": KvRows for Image digest (mono), Snapshot id (mono),
 *   Build (mono).
 * - Section "Scope rules": KvRows for Allow (localhost) and Egress (None).
 * - Section "Readiness": a row with "Health check", "Answered on port 3000",
 *   and a Ready pill.
 *
 * Data comes from GET /api/mobile/v1/reports/[id] which returns targetScope
 * fields on the case file view. The screen falls back to the m22.html mockup
 * values when no target is bound or the API has not returned yet.
 */
import { View, Text, ScrollView, StyleSheet } from "react-native"

import { useApiQuery, ApiError } from "@/lib/use-query"
import type { MobileCaseFileWithScope } from "@/lib/types"
import { useTheme } from "@/theme"
import { Card, KvRow, SectionHeader, ScreenHeader, Mono } from "@/components/primitives"

export default function TargetAndScopeScreen() {
  const { colors, phase: phaseColors } = useTheme()
  const { data: caseFile, error } = useApiQuery<MobileCaseFileWithScope>("/reports/BD-1042")

  const isAuthError = error instanceof ApiError && (error.status === 401 || error.status === 403)
  if (error && !isAuthError) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.error, { color: colors.red }]}>{error.message}</Text>
      </View>
    )
  }

  if (error) return null

  // Fall back to the m22.html mockup values for the demo target.
  const scope = caseFile?.targetScope
  const imageDigest = scope?.imageDigest ?? "sha256:9f2c4e0a7b1d6c83e5a24f90b7d1c3e86a5f0b2d94c71e8a3b6d05f2c8e1a947"
  const snapshotId = scope?.snapshotId ?? "snap-7c41e9d2"
  const buildMarker = scope?.buildMarker ?? "bd-build-1867b92-ok"
  const allow = scope?.scopeRules?.allow ?? ["localhost"]
  const egress = scope?.scopeRules?.egress ?? "None"
  const readinessPath = scope?.readinessPath ?? "/"
  const startCommand = scope?.startCommand ?? "npm start"

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Target and scope" back backLabel="Case file" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.h1, { color: colors.foreground }]}>Target and scope</Text>
        <Text style={[styles.hmeta, { color: colors.muted }]}>juice-shop · v17.3.0 · 1867b92</Text>

        {/* Pinned image */}
        <SectionHeader title="Pinned image" chevron={false} />
        <Card style={styles.card}>
          <KvRow
            label="Image digest"
            value={
              <Mono style={{ color: colors.foreground }}>
                {imageDigest}
              </Mono>
            }
          />
          <KvRow
            label="Snapshot id"
            value={
              <Mono style={{ color: colors.foreground }}>
                {snapshotId}
              </Mono>
            }
          />
          <KvRow
            label="Build"
            value={
              <Mono style={{ color: colors.foreground }}>
                {buildMarker}
              </Mono>
            }
          />
        </Card>

        {/* Scope rules */}
        <SectionHeader title="Scope rules" chevron={false} />
        <Card style={styles.card}>
          <KvRow label="Allow" value={allow.join(", ")} />
          <KvRow label="Egress" value={egress} />
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
                Answered on port 3000, readiness {readinessPath}
              </Text>
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
  scrollContent: { paddingTop: 6, paddingBottom: 100 },
  h1: { fontSize: 28, fontWeight: "700", letterSpacing: -0.03 * 28, lineHeight: 32, paddingHorizontal: 20, paddingTop: 16 },
  hmeta: { fontSize: 15, lineHeight: 20, paddingHorizontal: 20, marginBottom: 12 },
  card: { marginHorizontal: 16, borderRadius: 24, overflow: "hidden", marginBottom: 4 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 20, marginTop: 10 },
  readinessRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 18,
  },
  readinessMain: { flex: 1, minWidth: 0 },
  readinessTitle: { fontSize: 17, fontWeight: "500", lineHeight: 20 },
  readinessSubtitle: { fontSize: 13, marginTop: 3 },
  readyPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 99,
  },
  readyPillText: { fontSize: 13, fontWeight: "600", lineHeight: 14 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontSize: 16 },
})

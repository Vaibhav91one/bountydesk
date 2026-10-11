/** M27 Onboarding. How a repository becomes a bound target.
 *
 * The screen reads the connection row identified by the `id` route param, finds
 * it in GET /api/mobile/v1/connections (the same first render M15 uses), and
 * lights up the seven-stage diagram from onboardingProgress.state or
 * onboardingDetail.state. The Notes KvRows come from the row's real fields.
 */
import { View, Text, ScrollView, StyleSheet } from "react-native"
import Svg, { Path } from "react-native-svg"
import { useLocalSearchParams } from "expo-router"

import { useApiQuery, ApiError } from "@/lib/use-query"
import type { ConnectionRow } from "@/lib/types"
import { useTheme } from "@/theme"
import { Icon } from "@/components/icons"
import { Card, KvRow, SectionHeader, ScreenHeader, Mono, EmptyState } from "@/components/primitives"

type Stage = {
  label: string
  title: string
  detail: string
  icon: string
}

const STAGES: Stage[] = [
  {
    label: "Stage 1",
    title: "Connected repo",
    detail: "Repository added to the GitHub App install",
    icon: "github",
  },
  {
    label: "Stage 2",
    title: "Classify and review",
    detail: "Read-only check that the repo can be sandboxed",
    icon: "search",
  },
  {
    label: "Stage 3",
    title: "Build in sandbox",
    detail: "Image built with narrow dependency egress",
    icon: "cube",
  },
  {
    label: "Stage 4",
    title: "Snapshot and manifest",
    detail: "Agent proposes port, readiness path, start command",
    icon: "file",
  },
  {
    label: "Stage 5",
    title: "Human approves",
    detail: "The exact build, name and digest",
    icon: "check",
  },
  {
    label: "Stage 6",
    title: "Verify offline",
    detail: "Snapshot starts and answers its health check",
    icon: "shield",
  },
  {
    label: "Stage 7",
    title: "Configured target",
    detail: "TargetProfile written, bound to the repo",
    icon: "target",
  },
]

/**
 * Map an onboarding state to the diagram step it lights up.
 * PENDING_PLAN lives on Stage 2 (classification), the earlier stages are done.
 */
function stateToStep(state: string | null): number | null {
  switch (state) {
    case "PENDING_PLAN":
      return 2
    case "PENDING_BUILD":
      return 3
    case "PENDING_MANIFEST":
      return 4
    case "CONFIGURED":
      return 7
    default:
      return null
  }
}

export default function OnboardingScreen() {
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
          <EmptyState heading="Connection not found" inline />
        </ScrollView>
      </View>
    )
  }

  // A repo with no onboarding row at all.
  if (!row.onboarding && !row.onboardingProgress && !row.onboardingDetail) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader title="Onboarding" back backLabel="Connections" />
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.scrollContent, { alignItems: "center" }]}
          showsVerticalScrollIndicator={false}
        >
          <EmptyState heading="Not onboarded yet" inline />
        </ScrollView>
      </View>
    )
  }

  // FAILED or UNSUPPORTED shows the reason, nothing else.
  const progressFailed = row.onboardingProgress && (row.onboardingProgress.state === "FAILED" || row.onboardingProgress.state === "UNSUPPORTED")
  const detailFailed = row.onboardingDetail && (row.onboardingDetail.state === "FAILED" || row.onboardingDetail.state === "UNSUPPORTED")
  const failureState = progressFailed || detailFailed
  if (failureState) {
    const reason = row.onboardingProgress?.reason ?? row.onboardingDetail?.reason ?? "Onboarding failed"
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader title="Onboarding" back backLabel="Connections" />
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <Text style={[styles.h1, { color: colors.foreground }]}>Onboarding</Text>
          <Text style={[styles.hmeta, { color: colors.muted }]}>How a repository becomes a bound target</Text>
          <View style={styles.section}>
            <Text style={[styles.failedReason, { color: colors.red }]}>{reason}</Text>
          </View>
        </ScrollView>
      </View>
    )
  }

  const detail = row.onboardingDetail
  const progress = row.onboardingProgress
  const state = detail?.state ?? progress?.state ?? null
  const activeStep = stateToStep(state)

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Onboarding" back backLabel="Connections" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.h1, { color: colors.foreground }]}>Onboarding</Text>
        <Text style={[styles.hmeta, { color: colors.muted }]}>How a repository becomes a bound target</Text>

        {/* Seven-stage diagram */}
        <View style={styles.diagram}>
          {STAGES.map((stage, i) => {
            const step = i + 1
            const isLast = step === STAGES.length
            const hot = activeStep === step
            return (
              <View key={stage.label} style={styles.diagramNodeRow}>
                <View style={styles.diagramNode}>
                  <View style={[styles.nodeIcon, { backgroundColor: colors.fill }]}>
                    <Icon name={stage.icon as any} size={20} stroke={colors.foreground} />
                  </View>
                  <View style={styles.nodeMain}>
                    <Text style={[styles.nodeLabel, { color: colors.muted }]}>{stage.label}</Text>
                    <Text style={[styles.nodeTitle, { color: colors.foreground }]}>{stage.title}</Text>
                    <Text style={[styles.nodeDetail, { color: colors.muted }]}>{stage.detail}</Text>
                  </View>
                  {hot && <View style={[styles.hotOutline, { borderColor: colors.brand }]} />}
                </View>
                {!isLast && <StageConnector />}
              </View>
            )
          })}
        </View>

        {/* Notes */}
        <View style={styles.section}>
          <SectionHeader title="Notes" chevron={false} />
          <Card style={styles.card}>
            <KvRow label="Repository" value={row.fullName ?? "Not set"} />
            <KvRow
              label="Commit"
              value={
                detail?.buildMarker ? (
                  <Mono style={{ color: colors.foreground }}>
                    {detail.buildMarker.slice(0, 7)}
                  </Mono>
                ) : (
                  "Not set"
                )
              }
            />
            <KvRow
              label="Image"
              value={
                detail?.imageDigest ? (
                  <Mono style={{ color: colors.foreground }}>
                    {detail.imageDigest.slice(0, 12)}
                  </Mono>
                ) : (
                  "Not set"
                )
              }
            />
            <KvRow label="Strategy" value={detail?.strategy ?? "Not set"} />
            <KvRow label="Approved by" value={detail?.approvedBy ?? "Not set"} />
          </Card>
        </View>
        <Text style={[styles.note, { color: colors.muted }]}>
          Reproduction later runs in a sandbox with no egress. The onboarding build is the only stage
          that reaches the network.
        </Text>
      </ScrollView>
    </View>
  )
}

/** Vertical connector with a chevron arrow at the bottom, matching .conn in c.css. */
function StageConnector() {
  const { colors } = useTheme()
  return (
    <View style={styles.conn}>
      <Svg width={2} height={40} viewBox="0 0 2 40">
        <Path
          d="M1 0 V36 M1 36 L5 32 M1 36 L-3 32"
          stroke={colors.faint}
          strokeWidth={2}
          fill="none"
        />
      </Svg>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { paddingTop: 6, paddingBottom: 100 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontSize: 16 },
  h1: { fontSize: 28, fontWeight: "700", letterSpacing: -0.03 * 28, lineHeight: 32, paddingHorizontal: 20, paddingTop: 16 },
  hmeta: { fontSize: 15, lineHeight: 20, paddingHorizontal: 20, marginBottom: 12 },
  diagram: { paddingHorizontal: 16, gap: 0 },
  diagramNodeRow: { alignItems: "center" },
  diagramNode: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 20,
    backgroundColor: "transparent",
  },
  nodeIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  nodeMain: { flex: 1, minWidth: 0 },
  nodeLabel: { fontSize: 11, fontWeight: "600", letterSpacing: 0.08 * 11, textTransform: "uppercase", lineHeight: 14 },
  nodeTitle: { fontSize: 17, fontWeight: "600", lineHeight: 22, marginTop: 2 },
  nodeDetail: { fontSize: 13, marginTop: 2, lineHeight: 18 },
  hotOutline: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 20,
    borderWidth: 1.5,
    pointerEvents: "none",
  },
  conn: {
    alignSelf: "center",
    width: 2,
    height: 40,
    marginVertical: 0,
  },
  section: { marginBottom: 28 },
  card: { marginHorizontal: 16, borderRadius: 24, overflow: "hidden", marginBottom: 4 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 20, marginTop: 10 },
  failedReason: { fontSize: 15, lineHeight: 22, paddingHorizontal: 20, textAlign: "center" },
})

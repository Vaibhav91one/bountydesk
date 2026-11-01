/** M27 Onboarding. How a repository becomes a bound target.
 *
 * The screen reads the connection row identified by the `id` route param, finds
 * it in GET /api/mobile/v1/connections (the same first render M15 uses), and
 * lights up the seven-stage diagram from onboardingProgress.state or
 * onboardingDetail.state. The Notes KvRows come from the row's real fields.
 */
import { View, Text, ScrollView, StyleSheet } from "react-native"
import { useLocalSearchParams } from "expo-router"

import { useApiQuery, ApiError } from "@/lib/use-query"
import type { ConnectionRow } from "@/lib/types"
import { useTheme } from "@/theme"
import { Icon } from "@/components/icons"
import { ScreenHeader, EmptyState, LoadingState, ScreenTitle } from "@/components/primitives"
import { ListCard, SectionHead } from "@/components/ReportList"
import { BottomFade, KvLine, Note, shortCommit } from "@/components/CaseUi"
import { font } from "@/lib/fonts"

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
    detail: "{repo} at the pinned commit",
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
    case "AWAITING_APPROVAL":
      return 5
    case "APPROVED":
      return 6
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

  // Nothing to look up until the list arrives, so show the chrome only.
  if (!rows) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader back backLabel="Connections" />
        <LoadingState label="Loading connection" />
      </View>
    )
  }

  const row = rows.find((r) => String(r.repoId) === String(id))

  if (!row) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader back backLabel="Connections" />
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
        <ScreenHeader back backLabel="Connections" />
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
        <ScreenHeader back backLabel="Connections" />
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <ScreenTitle title="Onboarding" meta="How a repository becomes a bound target" metaBottom={24} />
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

  const commit = shortCommit(detail?.buildMarker)
  const status = row.configured ? "Configured" : STATE_LABELS[state ?? ""] ?? "Not set"

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader back backLabel="Connections" />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <ScreenTitle title="Onboarding" meta="How a repository becomes a bound target" metaBottom={24} />

        <View style={styles.diagram}>
          {STAGES.map((stage, i) => {
            const step = i + 1
            return (
              <View key={stage.label}>
                <StageNode stage={stage} repo={row.fullName} hot={activeStep === step} />
                {step < STAGES.length ? <StageConnector /> : null}
              </View>
            )
          })}
        </View>

        <View style={styles.notes}>
          <SectionHead title="Notes" />
          <ListCard>
            <KvLine label="Repository" value={row.name} />
            <KvLine label="Commit" value={commit ?? "Not set"} mono={!!commit} divider />
            <KvLine label="Status" value={status} divider />
          </ListCard>
          <Note>Reproduction later runs in a sandbox with no egress. The onboarding build is the only stage that reaches the network.</Note>
        </View>
      </ScrollView>
      <BottomFade />
    </View>
  )
}

const STATE_LABELS: Record<string, string> = {
  PENDING_PLAN: "Classifying",
  PENDING_BUILD: "Building",
  PENDING_MANIFEST: "Proposing manifest",
  AWAITING_APPROVAL: "Awaiting approval",
  APPROVED: "Approved",
  CONFIGURED: "Configured",
}

/** c.css .node: card surface, brand-tinted icon, a brand ring on the current stage. */
function StageNode({ stage, repo, hot }: { stage: Stage; repo: string; hot: boolean }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.node, { backgroundColor: colors.card }, hot && { boxShadow: `0 0 0 1.5px ${colors.brand}` }]}>
      <View style={[styles.nodeIcon, { backgroundColor: colors.brand + "29" }]}>
        <Icon name={stage.icon as any} size={22} stroke={colors["brand-soft"]} />
      </View>
      <View style={styles.nodeMain}>
        <Text style={[styles.nodeLabel, { color: colors.muted }]}>{stage.label}</Text>
        <Text style={[styles.nodeTitle, { color: colors.foreground }]}>{stage.title}</Text>
        <Text style={[styles.nodeDetail, { color: colors.muted }]}>{stage.detail.replace("{repo}", repo)}</Text>
      </View>
    </View>
  )
}

/** c.css .conn: a 2 by 40 line with an arrow head at the bottom. */
function StageConnector() {
  const { colors } = useTheme()
  return (
    <View style={[styles.conn, { backgroundColor: colors.faint }]}>
      <View style={[styles.arrow, { borderColor: colors.faint }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 150 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontFamily: font.regular, fontSize: 16 },
  diagram: { paddingHorizontal: 16 },
  node: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 20 },
  nodeIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  // Inter sits about half a point low in an RN line box compared with the browser; this evens the text out.
  nodeMain: { flex: 1, minWidth: 0, marginTop: -0.6 },
  nodeLabel: { fontFamily: font.semibold, fontSize: 11, lineHeight: 11, letterSpacing: 0.88, textTransform: "uppercase", marginBottom: 4 },
  nodeTitle: { fontFamily: font.semibold, fontSize: 17, lineHeight: 21.25, letterSpacing: -0.187 },
  nodeDetail: { fontFamily: font.regular, fontSize: 13, lineHeight: 17.55, marginTop: 2 },
  conn: { alignSelf: "center", width: 2, height: 40 },
  arrow: { position: "absolute", bottom: -1, left: -3, width: 8, height: 8, borderRightWidth: 2, borderBottomWidth: 2, transform: [{ rotate: "45deg" }] },
  notes: { marginTop: 28 },
  section: { marginBottom: 28 },
  failedReason: { fontFamily: font.regular, fontSize: 15, lineHeight: 22, paddingHorizontal: 20, textAlign: "center" },
})

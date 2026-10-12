/** M7 Case file. The detail screen for a single report. Matches
 * docs/site/screens/m7.html.
 *
 * Shows the phase pill, KvRows for report metadata, a bound target card, the
 * agent summary, findings list, and quick-link tiles to Timeline, Tool calls,
 * Sandbox, and Chat. A floating bar at the bottom holds a chat icon button and
 * an Open verdict primary button.
 *
 * Data: GET /api/mobile/v1/reports/[id] returns MobileCaseFile.
 */
import { View, Text, ScrollView, StyleSheet, Pressable, Share } from "react-native"
import { useRouter, useLocalSearchParams } from "expo-router"
import { useApiQuery, ApiError } from "@/lib/use-query"
import { useTheme } from "@/theme"
import { Icon } from "@/components/icons"
import { PhasePill, PrimaryButton, ScreenHeader, ScreenTitle, TopBarButton } from "@/components/primitives"
import { ListCard, SectionHead } from "@/components/ReportList"
import { BottomFade, ItemLine, ItemValue, KvLine, Note, shortCommit } from "@/components/CaseUi"
import { ageText } from "@/lib/age"
import { toolCallsOnly } from "@/lib/toolCalls"
import type { MobileCaseFile } from "@/lib/types"
import type { PhaseKey } from "@/lib/phases"
import { font } from "@/lib/fonts"

/** MobileCaseFile plus the targetScope fields the API returns but the local
 * type does not declare. OPEN QUESTIONS entry: targetScope is absent from
 * mobile/lib/types.ts's MobileCaseFile. */
type CaseFileView = MobileCaseFile & {
  targetScope: {
    imageDigest: string
    snapshotId: string | null
    buildMarker: string | null
    scopeRules: unknown[]
    readinessPath: string
    startCommand: string | null
    egress: "none" | "narrow"
  } | null
}

/** Finding shape from the verdict evidence. Copied from lib/mcp/verdict-draft
 * so this client file does not import server-only modules. */
interface Finding {
  title: string
  severity: string
  description: string
  evidenceRef: string
  cvssVector?: string
}

/** Map report state to the PhaseKey used by PhasePill. */
const STATE_TO_PHASE: Record<string, PhaseKey> = {
  TRIAGING: "triaging",
  NEEDS_DECISION: "triaging",
  REPRODUCING: "reproducing",
  ANALYSIS_ONLY: "analysis",
  AWAITING_APPROVAL: "approval",
  DELIVERING: "delivered",
  DELIVERED: "delivered",
  DENIED: "closed",
  OUT_OF_SCOPE: "closed",
  CANCELLED: "closed",
  EXPIRED: "closed",
}

function phaseForState(state: string): PhaseKey {
  return STATE_TO_PHASE[state] ?? "closed"
}

/** Severity ordering for deriving the report-level severity from findings. */
const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
}

function severityLabel(sev: string): string {
  return sev.charAt(0).toUpperCase() + sev.slice(1)
}

function reportSeverity(findings: Finding[]): string | null {
  if (!findings.length) return null
  const top = findings.reduce((best, f) =>
    SEVERITY_RANK[f.severity] > SEVERITY_RANK[best.severity] ? f : best, findings[0])
  return severityLabel(top.severity)
}

/** The design's label for a finding: an informational one is a confirmation. */
function findingLabel(sev: string): string {
  return sev.toLowerCase() === "info" ? "Confirmed" : severityLabel(sev)
}

/** Channel as the case file words it. */
const CHANNEL_LABEL: Record<string, string> = {
  github: "GitHub issue",
  advisory: "GitHub advisory",
  email: "Email",
  upload: "Upload",
}

interface FindingView {
  title: string
  evidenceRef: string
  severity: string
}

interface TileNavProps {
  icon: string
  label: string
  sub: string
  onPress: () => void
}

function TileNav({ icon, label, sub, onPress }: TileNavProps) {
  const { colors } = useTheme()
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.tile,
        { backgroundColor: colors.card, boxShadow: `0 0 0 1px ${colors["glass-edge"]}` },
        pressed && { opacity: 0.92 },
      ]}
    >
      <Icon name={icon as any} size={22} stroke={colors["brand-soft"]} />
      <View>
        <Text style={[styles.tileLabel, { color: colors.foreground }]}>{label}</Text>
        <Text style={[styles.tileSub, { color: colors.muted }]}>{sub}</Text>
      </View>
    </Pressable>
  )
}

export default function CaseFileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { colors } = useTheme()
  const router = useRouter()
  const { data: file, error } = useApiQuery<CaseFileView>(`/reports/${id}`)
  // The same id Queue and Reports show, and the one Reports search matches.
  const reportIdLabel = file?.sourceLabel ?? ""

  const isAuthError = error instanceof ApiError && (error.status === 401 || error.status === 403)
  if (error && !isAuthError) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.error, { color: colors.red }]}>{error.message}</Text>
      </View>
    )
  }

  // Only the first load shows the placeholder; a background refetch keeps the rendered file.
  if (!file) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" }}>
        <Text style={[styles.meta, { color: colors.muted }]}>Loading case file</Text>
      </View>
    )
  }

  const phase = phaseForState(file.state)
  const isApproval = phase === "approval"
  const findings = (file.verdict?.findings as Finding[] | undefined) ?? []
  const findingViews: FindingView[] = findings.slice(0, 8).map((f) => ({
    title: f.title,
    evidenceRef: f.evidenceRef,
    severity: f.severity,
  }))
  const sev = reportSeverity(findings)

  const targetSubtitle = [file.targetVersion, shortCommit(file.targetScope?.buildMarker)]
    .filter(Boolean)
    .join(" · ")
  const channel = file.channel ?? file.deliveryChannel
  const callCount = toolCallsOnly(file.toolCalls ?? []).length

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        back
        onBack={() => router.back()}
        backLabel="Home"
        right={
          <>
            <TopBarButton
              icon="share"
              label="Share"
              onPress={async () => {
                await Share.share({ message: `${reportIdLabel} ${file.title}` })
              }}
            />
            <TopBarButton icon="more" label="More" />
          </>
        }
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <ScreenTitle
          title={file.title}
          meta={
            <>
              <PhasePill
                phase={phase}
                label={phase === "approval" ? "Awaiting approval" : undefined}
                style={isApproval ? styles.approvalHalo : undefined}
              />
              <Text style={[styles.hmetaText, { color: colors.muted }]}>
                {reportIdLabel} · opened {ageText(file.createdAt, true)}
              </Text>
            </>
          }
        />

        <View style={styles.section}>
          <SectionHead title="Report" />
          <ListCard>
            <KvLine label="Severity" value={sev ?? "Not assessed"} strong={sev != null} />
            <KvLine label="Channel" value={channel ? (CHANNEL_LABEL[channel] ?? channel) : "—"} divider />
            <KvLine label="Reporter" value={file.reporterHandle ?? "Anonymous"} divider />
          </ListCard>
        </View>

        <View style={styles.section}>
          <SectionHead title="Bound target" />
          <ListCard>
            <Pressable
              disabled={!file.target}
              onPress={() => router.push(`/reports/${file.id}/target-and-scope`)}
              style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}
            >
              <ItemLine
                title={file.target ? (file.target.name ?? file.repositoryFullName ?? "Bound target") : "No target bound"}
                subtitle={file.target ? targetSubtitle : undefined}
                trailing={file.target ? <PhasePill phase="delivered" label="Verified" /> : undefined}
              />
            </Pressable>
          </ListCard>
          <Note>Reproduction ran against this pinned snapshot only.</Note>
        </View>

        <View style={styles.section}>
          <SectionHead title="Agent summary" />
          <ListCard flush>
            <Text style={[styles.body, { color: colors.foreground }]}>{file.summary ?? "No summary available."}</Text>
          </ListCard>
        </View>

        {findingViews.length > 0 ? (
          <View style={styles.section}>
            <SectionHead title="Findings" />
            <ListCard>
              {findingViews.map((f, i) => (
                <ItemLine
                  key={f.title}
                  title={f.title}
                  subtitle={f.evidenceRef}
                  divider={i > 0}
                  trailing={<ItemValue strong={f.severity.toLowerCase() !== "info"}>{findingLabel(f.severity)}</ItemValue>}
                />
              ))}
            </ListCard>
          </View>
        ) : null}

        <View style={styles.section}>
          <SectionHead title="Explore" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tiles}>
            <TileNav
              icon="clock"
              label="Timeline"
              sub={`${file.events?.length ?? 0} events`}
              onPress={() => router.push(`/reports/${file.id}/timeline`)}
            />
            <TileNav
              icon="terminal"
              label="Tool calls"
              sub={`${callCount} calls`}
              onPress={() => router.push(`/reports/${file.id}/tool-calls`)}
            />
            <TileNav
              icon="cube"
              label="Sandbox"
              sub="Path and oracle"
              onPress={() => router.push(`/reports/${file.id}/sandbox-diagram`)}
            />
            <TileNav
              icon="chat"
              label="Chat"
              sub="Reviewer"
              onPress={() => router.push(`/reports/${file.id}/chat`)}
            />
          </ScrollView>
        </View>
      </ScrollView>

      <BottomFade />
      <View style={[styles.fbar, { backgroundColor: colors.glass, borderColor: colors["glass-edge"] }]}>
        <Pressable
          onPress={() => router.push(`/reports/${file.id}/chat`)}
          style={({ pressed }) => [styles.fbarChat, { backgroundColor: colors.fill }, pressed && { opacity: 0.7 }]}
          accessibilityLabel="Open reviewer chat"
        >
          <Icon name="chat" size={22} stroke={colors.foreground} />
        </Pressable>
        <PrimaryButton
          title="Open verdict"
          onPress={() => router.push(`/reports/${file.id}/sign-the-verdict`)}
          style={styles.fbarBtn}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontFamily: font.regular, fontSize: 16 },
  meta: { fontFamily: font.regular, fontSize: 16 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 150 },
  hmetaText: { fontFamily: font.regular, fontSize: 15, lineHeight: 20.25 },
  approvalHalo: { alignSelf: "center" },
  section: { marginBottom: 28 },
  body: { fontFamily: font.regular, fontSize: 17, lineHeight: 25.5, letterSpacing: -0.187, paddingVertical: 16, paddingHorizontal: 18 },
  tiles: { gap: 12, paddingHorizontal: 16 },
  tile: { width: 112, minHeight: 104, borderRadius: 24, paddingVertical: 14, paddingHorizontal: 16, justifyContent: "space-between", gap: 10 },
  tileLabel: { fontFamily: font.semibold, fontSize: 17, lineHeight: 22.95, letterSpacing: -0.187 },
  tileSub: { fontFamily: font.regular, fontSize: 13, lineHeight: 17.55, marginTop: 2 },
  fbar: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 6,
    borderRadius: 36,
    borderWidth: 1,
  },
  fbarChat: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center" },
  fbarBtn: { flex: 1 },
})

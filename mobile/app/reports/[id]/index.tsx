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
import { View, Text, ScrollView, StyleSheet, Pressable } from "react-native"
import { useRouter, useLocalSearchParams } from "expo-router"
import { useApiQuery, ApiError } from "@/lib/use-query"
import { useTheme } from "@/theme"
import { Icon } from "@/components/icons"
import { KvRow, PhasePill, Card, PrimaryButton } from "@/components/primitives"
import type { MobileCaseFile } from "@/lib/types"
import type { PhaseKey } from "@/lib/phases"

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

/** Severity display labels matching c.css .sev / .sev.m / .sev.l colors. */
const SEVERITY_COLORS: Record<string, string> = {
  critical: "#EF4444",
  high: "#EF4444",
  medium: "#F59E0B",
  low: "#9CA3AF",
  info: "#9CA3AF",
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

/** Map a finding severity to its display color (c.css .sev rules). */
function severityColor(sev: string): string {
  const s = sev.toLowerCase()
  return SEVERITY_COLORS[s] ?? "#9CA3AF"
}

/** Relative age label, matching c.css ageLabelFor. */
function ageLabelFor(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h`
  if (hours < 24 * 7) return `${Math.floor(hours / 24)} d`
  return "Yesterday"
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
        { backgroundColor: colors.card, borderColor: colors["glass-edge"] },
        pressed && { opacity: 0.92 },
      ]}
    >
      <Icon name={icon as any} size={22} stroke={colors["brand-soft"]} />
      <Text style={[styles.tileLabel, { color: colors.foreground }]}>{label}</Text>
      <Text style={[styles.tileSub, { color: colors.muted }]}>{sub}</Text>
    </Pressable>
  )
}

export default function CaseFileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { colors } = useTheme()
  const router = useRouter()
  const { data: file, error, isFetching } = useApiQuery<CaseFileView>(`/reports/${id}`)

  const isAuthError = error instanceof ApiError && (error.status === 401 || error.status === 403)
  if (error && !isAuthError) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.error, { color: colors.red }]}>{error.message}</Text>
      </View>
    )
  }

  if (isFetching || !file) {
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

  const targetSubtitle = file.targetScope?.buildMarker
    ? `${file.targetScope.buildMarker} · ${file.targetScope.imageDigest?.slice(0, 7) ?? ""}`
    : file.target?.imageDigest
      ? file.target.imageDigest.slice(0, 7)
      : ""

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Back button (top-left glass round) */}
      <View style={styles.backWrapper}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [
            styles.glassRoundBtn,
            { backgroundColor: colors.glass, borderColor: colors["glass-edge"] },
            pressed && { opacity: 0.92 },
          ]}
          accessibilityLabel="Back"
        >
          <Icon name="back" size={24} strokeWidth={2.2} stroke={colors.foreground} />
        </Pressable>
      </View>

      {/* Top-right glass pill: Share + More */}
      <View style={styles.topRightWrapper}>
        <View style={[styles.glassPill, { backgroundColor: colors.glass, borderColor: colors["glass-edge"] }]}>
          <Pressable
            onPress={() => {}}
            style={({ pressed }) => [
              styles.iconBtn,
              { backgroundColor: colors.background },
              pressed && { opacity: 0.7 },
            ]}
            accessibilityLabel="Share"
          >
            <Icon name="share" size={22} stroke={colors.foreground} />
          </Pressable>
          <Pressable
            onPress={() => {}}
            style={({ pressed }) => [
              styles.iconBtn,
              { backgroundColor: colors.background },
              pressed && { opacity: 0.7 },
            ]}
            accessibilityLabel="More"
          >
            <Icon name="more" size={22} stroke={colors.foreground} />
          </Pressable>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* h1 + hmeta */}
        <Text style={[styles.h1, { color: colors.foreground }]}>{file.title}</Text>
        <View style={styles.hmeta}>
          <PhasePill
            phase={phase}
            label={phase === "approval" ? "Awaiting approval" : undefined}
            style={isApproval ? styles.approvalHalo : undefined}
          />
          <Text style={[styles.hmetaText, { color: colors.muted }]}>
            {file.id} · opened {ageLabelFor(file.createdAt)}
          </Text>
        </View>

        {/* Report section: KvRows */}
        <View style={styles.section}>
          <Text style={[styles.shPlain, { color: colors.foreground }]}>Report</Text>
          <Card style={styles.cardList}>
            <KvRow label="Severity" value={sev ?? "Not assessed"} />
            <KvRow label="Channel" value={file.channel ?? file.deliveryChannel ?? "—"} />
            <KvRow label="Reporter" value={file.reporterHandle ?? "Anonymous"} />
          </Card>
        </View>

        {/* Bound target section */}
        <View style={styles.section}>
          <Text style={[styles.shPlain, { color: colors.foreground }]}>Bound target</Text>
          <Card style={styles.cardList}>
            <Pressable
              onPress={() => router.push(`/more/target-and-scope`)}
              style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}
            >
              <View style={styles.targetRow}>
                <View style={styles.targetMain}>
                  <Text style={[styles.targetTitle, { color: colors.foreground }]} numberOfLines={1}>
                    {file.target?.name ?? file.repositoryFullName ?? "No target bound"}
                  </Text>
                  {targetSubtitle ? (
                    <Text style={[styles.targetSubtitle, { color: colors.muted }]} numberOfLines={1}>
                      {targetSubtitle}
                    </Text>
                  ) : null}
                </View>
                {file.target ? (
                  <PhasePill phase="delivered" label="Verified" style={styles.targetPill} />
                ) : null}
              </View>
            </Pressable>
          </Card>
          <Text style={[styles.note, { color: colors.muted }]}>
            Reproduction ran against this pinned snapshot only.
          </Text>
        </View>

        {/* Agent summary section */}
        <View style={styles.section}>
          <Text style={[styles.shPlain, { color: colors.foreground }]}>Agent summary</Text>
          <Card style={styles.summaryCard}>
            <Text style={[styles.body, { color: colors.foreground }]}>
              {file.summary ?? "No summary available."}
            </Text>
          </Card>
        </View>

        {/* Findings section */}
        {findingViews.length > 0 ? (
          <View style={styles.section}>
            <Text style={[styles.shPlain, { color: colors.foreground }]}>Findings</Text>
            <Card style={styles.cardList}>
              {findingViews.map((f, i) => (
                <View
                  key={f.title}
                  style={[
                    styles.findItem,
                    i < findingViews.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
                  ]}
                >
                  <View style={styles.findMain}>
                    <Text style={[styles.findTitle, { color: colors.foreground }]} numberOfLines={1}>
                      {f.title}
                    </Text>
                    <Text style={[styles.findSub, { color: colors.muted }]} numberOfLines={1}>
                      {f.evidenceRef}
                    </Text>
                  </View>
                  <Text style={[styles.findSev, { color: severityColor(f.severity) }]}>
                    {severityLabel(f.severity)}
                  </Text>
                </View>
              ))}
            </Card>
          </View>
        ) : null}

        {/* Explore section: quick-link tiles */}
        <View style={styles.section}>
          <Text style={[styles.shPlain, { color: colors.foreground }]}>Explore</Text>
          <View style={styles.tiles}>
            <TileNav
              icon="clock"
              label="Timeline"
              sub={`${file.events?.length ?? 0} events`}
              onPress={() => router.push(`/reports/${file.id}/timeline`)}
            />
            <TileNav
              icon="terminal"
              label="Tool calls"
              sub={`${file.toolCalls?.length ?? 0} calls`}
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
          </View>
        </View>
      </ScrollView>

      {/* Floating bar: chat icon + Open verdict */}
      <View style={[styles.fbar, { backgroundColor: colors.glass, borderColor: colors["glass-edge"] }]}>
        <Pressable
          onPress={() => router.push(`/reports/${file.id}/chat`)}
          style={({ pressed }) => [
            styles.fbarChat,
            { backgroundColor: colors.fill },
            pressed && { opacity: 0.7 },
          ]}
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
  backWrapper: { position: "absolute", top: 54, left: 16, zIndex: 30 },
  glassRoundBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
  },
  topRightWrapper: { position: "absolute", top: 54, right: 16, zIndex: 30 },
  glassPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 24,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontSize: 16 },
  meta: { fontSize: 16 },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: 84, paddingHorizontal: 20, paddingBottom: 120 },
  h1: { fontSize: 28, fontWeight: "700", letterSpacing: -0.03 * 28, marginBottom: 4 },
  hmeta: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 28 },
  hmetaText: { fontSize: 15 },
  approvalHalo: { alignSelf: "center" },
  section: { marginBottom: 28 },
  shPlain: { fontSize: 20, fontWeight: "600", lineHeight: 24, marginBottom: 12 },
  cardList: { marginHorizontal: 0, borderRadius: 24, overflow: "hidden" },
  summaryCard: { marginHorizontal: 0, borderRadius: 24, overflow: "hidden", padding: 0 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 0, marginTop: 8 },
  body: { fontSize: 17, lineHeight: 24, padding: 18 },
  targetRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 18 },
  targetMain: { flex: 1, minWidth: 0 },
  targetTitle: { fontSize: 16, fontWeight: "500", lineHeight: 20 },
  targetSubtitle: { fontSize: 13, marginTop: 3 },
  targetPill: { alignSelf: "center" },
  findItem: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 10, paddingHorizontal: 18, minHeight: 56 },
  findMain: { flex: 1, minWidth: 0, marginRight: 12 },
  findTitle: { fontSize: 16, fontWeight: "500", lineHeight: 20 },
  findSub: { fontSize: 13, marginTop: 3 },
  findSev: { fontSize: 13, fontWeight: "600" },
  tiles: { flexDirection: "row", gap: 12, flexWrap: "wrap" },
  tile: {
    flex: 1,
    minWidth: 120,
    minHeight: 100,
    borderRadius: 24,
    padding: 16,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tileLabel: { fontSize: 15, fontWeight: "600", lineHeight: 20 },
  tileSub: { fontSize: 12, lineHeight: 16 },
  fbar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  fbarChat: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 0,
  },
  fbarBtn: { flex: 1 },
})
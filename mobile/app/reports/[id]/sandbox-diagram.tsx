/** M26 Sandbox diagram. Shows the reproduction sandbox architecture.
 *
 * Matches docs/site/screens/m26.html: four nodes in a vertical stack with
 * connectors between them, and a Notes section of key/value rows. Data comes
 * from GET /reports/[id]: target.name, targetScope.snapshotId, targetScope.egress,
 * and the static "Outside the sandbox" oracle note. The diagram itself is a
 * custom View layout — no @expo/ui equivalent exists for it.
 */
import { View, Text, ScrollView, StyleSheet } from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useApiQuery, ApiError } from "@/lib/use-query"
import type { MobileCaseFile } from "@/lib/types"
import { ScreenHeader, ScreenTitle, LoadingState } from "@/components/primitives"
import { ListCard, SectionHead } from "@/components/ReportList"
import { BottomFade, KvLine, Note } from "@/components/CaseUi"
import { Icon } from "@/components/icons"
import { useTheme } from "@/theme"
import { font } from "@/lib/fonts"

/** The four sandbox-diagram nodes from m26.html, in order. */
const NODES = [
  {
    kind: "build",
    badge: "Untrusted build",
    title: "Build sandbox",
    subtitle: "Narrow dependency egress",
    icon: "cube" as const,
    hot: false,
    off: false,
  },
  {
    kind: "repro",
    badge: "Offline run",
    title: "Reproduction sandbox",
    subtitle: "No egress · immutable snapshot",
    icon: "lock" as const,
    hot: true,
    off: false,
  },
  {
    kind: "oracle",
    badge: "External check",
    title: "Canary oracle",
    subtitle: "Outside the sandbox",
    icon: "target" as const,
    hot: false,
    off: false,
  },
  {
    kind: "human",
    badge: "Human gate",
    title: "Verdict",
    subtitle: "Drafted, then human approved",
    icon: "shield" as const,
    hot: false,
    off: true,
  },
] as const

/** The connector labels between consecutive nodes. */
const CONNECTORS = ["Built artifact only", "Probe results only", "Reviewer approves exact text"]

/** The short commit in a build marker, which is the source commit baked into the image. */
function shortCommit(marker: string | null | undefined): string | null {
  return marker?.match(/[0-9a-f]{7,40}/)?.[0].slice(0, 7) ?? null
}

export default function SandboxDiagramScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { colors } = useTheme()
  const { data: report, error, isError, isLoading } = useApiQuery<MobileCaseFile>(`/reports/${id}`)

  const isAuthError = error instanceof ApiError && (error.status === 401 || error.status === 403)
  if (isAuthError) return null
  if (isError) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.error, { color: colors.red }]}>{error?.message}</Text>
      </View>
    )
  }

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader back backLabel="Case file" />
        <LoadingState label="Loading sandbox" />
      </View>
    )
  }

  const target = report?.target
  // targetScope is returned by GET /reports/[id] (see docs/mobile-api.md) but is
  // not yet in mobile/lib/types.ts's MobileCaseFile. Cast to read it; removing
  // this cast once the type is updated is the OPEN QUESTION.
  const targetScope = (report as MobileCaseFile & {
    targetScope: { snapshotId: string | null; buildMarker: string | null; egress: string | null } | null
  })?.targetScope

  const egress = targetScope?.egress ?? "none"
  const notes = [
    { label: "Target", value: [target?.name.split("/").pop() ?? "unknown", report?.targetVersion].filter(Boolean).join(" ") },
    {
      label: "Snapshot",
      value: shortCommit(targetScope?.buildMarker) ?? targetScope?.snapshotId ?? target?.imageDigest?.slice(0, 12) ?? "—",
    },
    { label: "Egress", value: egress.charAt(0).toUpperCase() + egress.slice(1) },
    { label: "Oracle", value: "Outside the sandbox" },
  ]

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader back backLabel="Case file" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <ScreenTitle
          title="Reproduction sandbox"
          meta={report ? `${report.sourceLabel} · ${report.title}` : ""}
          metaBottom={20}
        />
        <View style={styles.diag}>
          {NODES.map((node, index) => (
            <View key={node.kind}>
              <SandboxNode node={node} />
              {index < NODES.length - 1 ? <Connector label={CONNECTORS[index]} dashed={index === CONNECTORS.length - 1} /> : null}
            </View>
          ))}
        </View>

        <View style={styles.notes}>
          <SectionHead title="Notes" />
          <ListCard>
            {notes.map((row, i) => (
              <KvLine key={row.label} label={row.label} value={row.value} mono={row.label === "Snapshot"} divider={i > 0} />
            ))}
          </ListCard>
          <Note>
            The oracle runs outside the sandbox. A sandbox status file reports readiness only and never decides the outcome.
          </Note>
        </View>
      </ScrollView>
      <BottomFade />
    </View>
  )
}

interface SandboxNodeProps {
  node: {
    badge: string
    title: string
    subtitle: string
    icon: "cube" | "lock" | "target" | "shield"
    hot: boolean
    off: boolean
  }
}

/** c.css .node. The mockup's `.off` node sets `border-style: dashed` and no width or colour, so it
 * renders as a 3px dashed border in the text colour; that is what is drawn here. */
function SandboxNode({ node }: SandboxNodeProps) {
  const { colors } = useTheme()
  return (
    <View
      style={[
        styles.node,
        node.off
          ? { borderWidth: 3, borderStyle: "dashed", borderColor: colors.foreground }
          : { backgroundColor: colors.card },
        node.hot && { boxShadow: `0 0 0 1.5px ${colors.brand}` },
      ]}
    >
      <View style={[styles.nodeIcon, { backgroundColor: colors.brand + "29" }]}>
        <Icon name={node.icon} size={22} stroke={colors["brand-soft"]} />
      </View>
      <View style={styles.nodeMain}>
        <Text style={[styles.nodeBadge, { color: colors.muted }]}>{node.badge}</Text>
        <Text style={[styles.nodeTitle, { color: colors.foreground }]}>{node.title}</Text>
        <Text style={[styles.nodeSubtitle, { color: colors.muted }]}>{node.subtitle}</Text>
      </View>
    </View>
  )
}

/** c.css .conn: a 2 by 40 arrow between nodes with its label to the right; .dash breaks the line into 5 on, 4 off. */
function Connector({ label, dashed }: { label: string; dashed: boolean }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.conn, !dashed && { backgroundColor: colors.faint }]}>
      {dashed
        ? [0, 9, 18, 27, 36].map((top) => (
            <View key={top} style={{ position: "absolute", top, height: Math.min(5, 40 - top), width: 2, backgroundColor: colors.faint }} />
          ))
        : null}
      <View style={[styles.arrow, { borderColor: colors.faint }]} />
      <Text style={[styles.connLabel, { color: colors.muted }]}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 150 },
  diag: { paddingHorizontal: 16 },
  node: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 20 },
  nodeIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  nodeMain: { flex: 1, minWidth: 0 },
  nodeBadge: { fontFamily: font.semibold, fontSize: 11, lineHeight: 11, letterSpacing: 0.88, textTransform: "uppercase", marginBottom: 4 },
  nodeTitle: { fontFamily: font.semibold, fontSize: 17, lineHeight: 21.25, letterSpacing: -0.187 },
  nodeSubtitle: { fontFamily: font.regular, fontSize: 13, lineHeight: 17.33, marginTop: 2 },
  conn: { alignSelf: "center", width: 2, height: 40 },
  arrow: {
    position: "absolute",
    bottom: -1,
    left: -3,
    width: 8,
    height: 8,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    transform: [{ rotate: "45deg" }],
  },
  connLabel: { position: "absolute", left: 14, top: 11.9, fontFamily: font.regular, fontSize: 12, lineHeight: 16.2, width: 220 },
  notes: { marginTop: 28 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontFamily: font.regular, fontSize: 16 },
})

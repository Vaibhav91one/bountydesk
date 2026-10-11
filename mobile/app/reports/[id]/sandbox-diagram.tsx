/** M26 Sandbox diagram. Shows the reproduction sandbox architecture.
 *
 * Matches docs/site/screens/m26.html: four nodes in a vertical stack with
 * connectors between them, and a Notes section of key/value rows. Data comes
 * from GET /reports/[id]: target.name, targetScope.snapshotId, targetScope.egress,
 * and the static "Outside the sandbox" oracle note. The diagram itself is a
 * custom View layout — no @expo/ui equivalent exists for it.
 */
import { View, Text, StyleSheet } from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useApiQuery, ApiError } from "@/lib/use-query"
import type { MobileCaseFile } from "@/lib/types"
import { ScreenHeader, KvRow, EmptyState } from "@/components/primitives"
import { Icon } from "@/components/icons"
import { useTheme } from "@/theme"

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

export default function SandboxDiagramScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { colors, typography } = useTheme()
  const { data: report, error, isError } = useApiQuery<MobileCaseFile>(`/reports/${id}`)

  const isAuthError = error instanceof ApiError && (error.status === 401 || error.status === 403)
  if (isAuthError) return null
  if (isError) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.error, { color: colors.red }]}>{error?.message}</Text>
      </View>
    )
  }

  const target = report?.target
  // targetScope is returned by GET /reports/[id] (see docs/mobile-api.md) but is
  // not yet in mobile/lib/types.ts's MobileCaseFile. Cast to read it; removing
  // this cast once the type is updated is the OPEN QUESTION.
  const targetScope = (report as MobileCaseFile & {
    targetScope: { snapshotId: string | null; egress: string | null } | null
  })?.targetScope

  const notes = [
    { label: "Target", value: target?.name ?? "unknown" },
    { label: "Snapshot", value: targetScope?.snapshotId ?? target?.imageDigest?.slice(0, 12) ?? "—" },
    { label: "Egress", value: targetScope?.egress ?? "None" },
    { label: "Oracle", value: "Outside the sandbox" },
  ]

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="Reproduction sandbox"
        meta={
          report ? `${report.id} · ${report.title}` : ""
        }
        back
        backLabel="Case file"
        onBack={() => router.back()}
      />

      <View style={styles.diag}>
        {NODES.map((node, index) => (
          <View key={node.kind}>
            <SandboxNode
              node={node}
              colors={colors}
              mono={typography.fontMono}
            />
            {index < NODES.length - 1 ? (
              <Connector label={CONNECTORS[index]} colors={colors} dashed={index === CONNECTORS.length - 1} />
            ) : null}
          </View>
        ))}
      </View>

      <View style={styles.notesSection}>
        <Text style={[styles.sectionHeader, { color: colors.foreground }]}>Notes</Text>
        <View style={[styles.notesCard, { backgroundColor: colors.card }]}>
          {notes.map((row, i) => (
            <KvRow
              key={row.label}
              label={row.label}
              value={row.value}
              mono={row.label === "Snapshot"}
              style={i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line } : undefined}
            />
          ))}
        </View>
        <Text style={[styles.note, { color: colors.muted, fontFamily: typography.fontFamily }]}>
          The oracle runs outside the sandbox. A sandbox status file reports readiness only and never decides the outcome.
        </Text>
      </View>
    </View>
  )
}

interface SandboxNodeProps {
  node: {
    kind: string
    badge: string
    title: string
    subtitle: string
    icon: "cube" | "lock" | "target" | "shield"
    hot: boolean
    off: boolean
  }
  colors: ReturnType<typeof useTheme>["colors"]
  mono: string
}

function SandboxNode({ node, colors, mono }: SandboxNodeProps) {
  const isOff = node.off
  const containerBg = isOff ? "transparent" : colors.card
  const containerBorder = isOff ? colors.line : "transparent"
  const badgeColor = colors["brand-soft"]
  return (
    <View
      style={[
        styles.node,
        {
          backgroundColor: containerBg,
          borderColor: containerBorder,
          borderWidth: isOff ? 1.5 : 0,
          borderStyle: "dashed",
          shadowColor: node.hot ? colors.brand : "transparent",
        },
      ]}
    >
      <View style={[styles.nodeIcon, { backgroundColor: `${colors.brand}29` }]}>
        <Icon name={node.icon} size={24} stroke={colors["brand-soft"]} />
      </View>
      <View style={styles.nodeMain}>
        <Text style={[styles.nodeBadge, { color: badgeColor }]}>{node.badge}</Text>
        <Text style={[styles.nodeTitle, { color: colors.foreground }]}>{node.title}</Text>
        <Text style={[styles.nodeSubtitle, { color: colors.muted }]}>{node.subtitle}</Text>
      </View>
    </View>
  )
}

function Connector({
  label,
  colors,
  dashed,
}: {
  label: string
  colors: ReturnType<typeof useTheme>["colors"]
  dashed: boolean
}) {
  return (
    <View style={styles.connectorCol}>
      <View
        style={[
          styles.connectorLine,
          {
            backgroundColor: colors.faint,
            borderTopWidth: 2,
            borderTopColor: dashed ? "transparent" : colors.faint,
          },
        ]}
      >
        {dashed ? (
          <View style={[styles.connectorDash, { backgroundColor: colors.faint }]} />
        ) : null}
      </View>
      <Text style={[styles.connectorLabel, { color: colors.muted }]}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  diag: {
    flexDirection: "column",
    alignItems: "stretch",
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  node: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 20,
  },
  nodeHot: {
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 0,
    elevation: 0,
  },
  nodeIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  nodeMain: {
    flex: 1,
    minWidth: 0,
  },
  nodeBadge: {
    fontSize: 11,
    fontWeight: "600",
    lineHeight: 14,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  nodeTitle: {
    fontSize: 17,
    fontWeight: "600",
    lineHeight: 22,
  },
  nodeSubtitle: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  connectorCol: {
    alignItems: "flex-start",
    paddingLeft: 54,
  },
  connectorLine: {
    width: 2,
    height: 40,
    marginVertical: 2,
  },
  connectorDash: {
    position: "absolute",
    left: 0,
    width: 2,
    height: 40,
    borderLeftWidth: 2,
  },
  connectorLabel: {
    fontSize: 12,
    lineHeight: 18,
  },
  notesSection: {
    marginTop: 28,
    paddingHorizontal: 20,
  },
  sectionHeader: {
    fontSize: 20,
    fontWeight: "600",
    lineHeight: 24,
    marginBottom: 10,
  },
  notesCard: {
    borderRadius: 24,
    overflow: "hidden",
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 10,
    textAlign: "center",
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  error: {
    fontSize: 16,
  },
})

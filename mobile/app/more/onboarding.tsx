/** M27 Onboarding. How a repository becomes a bound target.
 *
 * Matches docs/site/screens/m27.html exactly:
 * - Top bar with a round glass back button (back to Connections / M14).
 * - H1 "Onboarding", meta "How a repository becomes a bound target".
 * - A seven-stage diagram as a custom View: nodes connected by vertical
 *   connector lines with chevron arrows. Stage 3 (Build in sandbox) is hot
 *   (outlined with the brand color).
 * - Section "Notes": KvRows for Repository (juice-shop), Commit (1867b92 mono),
 *   Status (Configured).
 * - A footnote about reproduction running offline with no egress.
 *
 * The diagram has no @expo/ui equivalent (docs/site/native-ui.html) so it is
 * built as a plain View tree with absolute-positioned connector lines.
 */
import { View, Text, ScrollView, StyleSheet } from "react-native"
import Svg, { Path, Circle } from "react-native-svg"

import { useTheme } from "@/theme"
import { Icon } from "@/components/icons"
import { Card, KvRow, SectionHeader, ScreenHeader, Mono } from "@/components/primitives"

type Stage = {
  label: string
  title: string
  detail: string
  icon: string
  hot?: boolean
}

const STAGES: Stage[] = [
  {
    label: "Stage 1",
    title: "Connected repo",
    detail: "Vaibhav91one/juice-shop at the pinned commit",
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
    hot: true,
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

export default function OnboardingScreen() {
  const { colors } = useTheme()

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
            const isLast = i === STAGES.length - 1
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
                  {stage.hot && <View style={[styles.hotOutline, { borderColor: colors.brand }]} />}
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
            <KvRow label="Repository" value="juice-shop" />
            <KvRow
              label="Commit"
              value={<Mono style={{ color: colors.foreground }}>1867b92</Mono>}
            />
            <KvRow label="Status" value="Configured" />
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
})

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
import { PhasePill, ScreenHeader, EmptyState, ScreenTitle } from "@/components/primitives"
import { ListCard, SectionHead } from "@/components/ReportList"
import { BottomFade, ItemLine, KvLine, Note, shortCommit } from "@/components/CaseUi"
import { font } from "@/lib/fonts"

function ruleValue(entry: unknown): string {
  if (entry && typeof entry === "object" && "allow" in entry && typeof (entry as any).allow === "string") {
    return (entry as any).allow
  }
  return JSON.stringify(entry)
}

export default function TargetAndScopeScreen() {
  const { colors } = useTheme()
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

  const meta = [target?.name.split("/").pop(), caseFile?.targetVersion, shortCommit(scope.buildMarker)].filter(Boolean).join(" · ")

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader back backLabel="Case file" />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <ScreenTitle title="Target and scope" meta={meta} metaBottom={20} />

        <View style={styles.sect}>
          <SectionHead title="Pinned image" />
          <ListCard>
            <KvLine label="Image digest" value={scope.imageDigest} mono stacked />
            {scope.snapshotId ? <KvLine label="Snapshot id" value={scope.snapshotId} mono divider /> : null}
            {scope.buildMarker ? <KvLine label="Build" value={scope.buildMarker} mono divider /> : null}
          </ListCard>
        </View>

        <View style={styles.sect}>
          <SectionHead title="Scope rules" />
          <ListCard>
            {(scope.scopeRules ?? []).map((entry, i) => (
              <KvLine key={i} label="Allow" value={ruleValue(entry)} divider={i > 0} />
            ))}
            <KvLine label="Egress" value={scope.egress === "none" ? "None" : scope.egress} divider={(scope.scopeRules ?? []).length > 0} />
          </ListCard>
          <Note>Reproduction runs offline in a sandbox. The only network the agent can reach is the target.</Note>
        </View>

        <View style={styles.sect}>
          <SectionHead title="Readiness" />
          <ListCard>
            <ItemLine title="Health check" subtitle={scope.port ? `Answered on port ${scope.port}` : `Answered at ${scope.readinessPath}`} trailing={<PhasePill phase="delivered" label="Ready" />} />
          </ListCard>
          <Note>This profile is held on the server. The agent cannot change it, scope is never taken from agent text, and a sandbox status file reports readiness only.</Note>
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
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontFamily: font.regular, fontSize: 16 },
})

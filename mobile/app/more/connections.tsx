/** M14 Connections. GitHub App installations and their repositories.
 *
 * Matches docs/site/screens/m14.html exactly:
 * - Top bar with a round glass back button (back to Settings / M19).
 * - H1 "Connections", meta subtitle.
 * - Section "Installation": a button with the GitHub glyph, the account name
 *   and a hint line, and a chevron. Tapping it opens the GitHub App install URL.
 * - Section "Repositories": rows per repo with a title, subtitle and a status
 *   pill (Target bound / No target / Policy refused). Rows link to M15.
 * - Section "Targets": two link rows to M27 (Onboarding) and M28 (Submit a target).
 * - Footer bar with "Install GitHub App" button.
 *
 * Data comes from GET /api/mobile/v1/connections, which returns RepositoryRow[]
 * (connectionRows on the server). The rows are grouped by account login for the
 * Installation header above the Repositories list.
 */
import { View, Text, ScrollView, StyleSheet, Linking, Pressable } from "react-native"
import { useRouter } from "expo-router"

import { useApiQuery, ApiError } from "@/lib/use-query"
import type { ConnectionRow } from "@/lib/types"
import { useTheme } from "@/theme"
import { GlassBlur } from "@/components/GlassBlur"
import { Icon } from "@/components/icons"
import { PhasePill, PrimaryButton, ScreenHeader, ToastProvider, ScreenTitle, phaseTint } from "@/components/primitives"
import { ListCard, SectionHead } from "@/components/ReportList"
import { BottomFade, ItemLine, Note } from "@/components/CaseUi"
import { font } from "@/lib/fonts"

// The Install button opens the web app's Connections page in the system
// browser. That page holds the real GitHub App install link; the mobile
// client never hardcodes an installation slug.
const CONNECTIONS_URL = `${process.env.EXPO_PUBLIC_API_BASE}/connections`

function InstallRow({ title, subtitle, onPress }: { title: string; subtitle: string; onPress: () => void }) {
  const { colors } = useTheme()
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]} accessibilityLabel={title}>
      <ItemLine
        title={title}
        subtitle={subtitle}
        leading={
          <View style={[styles.avatar, { backgroundColor: colors.brand + "38" }]}>
            <Icon name="github" size={20} stroke={colors["brand-soft"]} />
          </View>
        }
        trailing={<Icon name="chev" size={18} stroke={colors.faint} />}
      />
    </Pressable>
  )
}

export default function ConnectionsScreen() {
  const { colors } = useTheme()
  const { data: rows, error } = useApiQuery<ConnectionRow[]>("/connections")
  // M27 is per repository, so the shortcut opens the first one with an onboarding record.
  const onboardingRepo = rows?.find((r) => r.onboardingDetail || r.onboardingProgress) ?? null
  const router = useRouter()

  const isAuthError = error instanceof ApiError && (error.status === 401 || error.status === 403)
  if (error && !isAuthError) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.error, { color: colors.red }]}>{error.message}</Text>
      </View>
    )
  }

  if (error) return null

  // One installation row per GitHub account, each with its own repository count, so a second
  // account's repositories are never counted under the first.
  const accounts: { account: string; count: number }[] = []
  for (const row of rows ?? []) {
    const entry = accounts.find((a) => a.account === row.account)
    if (entry) entry.count += 1
    else accounts.push({ account: row.account, count: 1 })
  }

  const handleInstall = () => {
    Linking.openURL(CONNECTIONS_URL)
  }

  return (
    <ToastProvider>
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader back backLabel="Settings" />
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <ScreenTitle title="Connections" meta="GitHub App installations and their repositories" metaBottom={24} />

          <View style={styles.sect}>
            <SectionHead title="Installation" />
            <ListCard>
              {accounts.length === 0 ? (
                <InstallRow title="GitHub App not installed" subtitle="Install it to connect repositories" onPress={handleInstall} />
              ) : (
                accounts.map(({ account, count }) => (
                  <InstallRow
                    key={account}
                    title={account}
                    subtitle={`GitHub App installed · ${count} ${count === 1 ? "repository" : "repositories"}`}
                    onPress={handleInstall}
                  />
                ))
              )}
            </ListCard>
          </View>

          <View style={styles.sect}>
            <SectionHead title="Repositories" />
            <ListCard>
              {rows && rows.length > 0 ? (
                rows.map((row, i) => (
                  <RepoRow key={row.id} row={row} divider={i > 0} onPress={() => router.push(`/more/connections/${row.repoId}`)} />
                ))
              ) : (
                <View style={styles.emptyRow}>
                  <Text style={[styles.emptyText, { color: colors.muted }]}>No repositories connected</Text>
                </View>
              )}
            </ListCard>
            <Note>Reproduction needs a bound target. A repository without one stops at analysis only.</Note>
          </View>

          <View style={styles.sect}>
            <SectionHead title="Targets" />
            <ListCard>
              {onboardingRepo ? (
                <TargetLink
                  title="View onboarding"
                  subtitle="How a repository becomes a bound target"
                  onPress={() => router.push(`/more/connections/${onboardingRepo.repoId}/onboarding`)}
                />
              ) : null}
              <TargetLink
                title="Upload a target"
                subtitle="Archive, Dockerfile or prebuilt image"
                divider={!!onboardingRepo}
                onPress={() => router.push("/more/submit-a-target")}
              />
            </ListCard>
          </View>
          <View style={{ marginTop: -10 }}>
            <Note>Least privilege: Metadata, Issues and Repository security advisories. Contents read is added only for private repositories.</Note>
          </View>
        </ScrollView>

        <BottomFade />
        <View style={[styles.fbar, { backgroundColor: colors.glass, borderColor: colors["glass-edge"], overflow: "hidden" }]}><GlassBlur />
          <PrimaryButton title="Install GitHub App" onPress={handleInstall} style={styles.btn} />
        </View>
      </View>
    </ToastProvider>
  )
}

function RepoRow({ row, divider, onPress }: { row: ConnectionRow; divider: boolean; onPress: () => void }) {
  const pill = repoStatusPill(row)
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}>
      <ItemLine title={row.name} subtitle={repoStatusHint(row)} divider={divider} trailing={pill} />
    </Pressable>
  )
}

function repoStatusPill(row: ConnectionRow) {
  if (row.status === "suspended" || row.status === "archived" || row.status === "disconnected") return <RedPill label="Policy refused" />
  if (row.configured) return <PhasePill phase="delivered" label="Target bound" />
  return <PhasePill phase="closed" label="No target" />
}

function repoStatusHint(row: ConnectionRow): string {
  const visibility = row.isPrivate ? "Private" : "Public"
  switch (row.status) {
    case "suspended":
      return `${visibility} · Suspended`
    case "archived":
      return `${visibility} · Archived`
    case "disconnected":
      return `${visibility} · Disconnected`
    default:
      if (row.configured && row.target) {
        return `${visibility} · ${row.target}`
      }
      return `${visibility} · ${row.branch ?? "No target"}`
  }
}

function RedPill({ label }: { label: string }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.pill, { backgroundColor: phaseTint(colors.red) }]}>
      <View style={[styles.pillDot, { backgroundColor: colors.red }]} />
      <Text style={[styles.pillLabel, { color: colors.red }]}>{label}</Text>
    </View>
  )
}

function TargetLink({ title, subtitle, divider, onPress }: { title: string; subtitle: string; divider?: boolean; onPress: () => void }) {
  const { colors } = useTheme()
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}>
      <ItemLine title={title} subtitle={subtitle} divider={divider} trailing={<Icon name="chev" size={18} stroke={colors.faint} />} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 150 },
  sect: { marginBottom: 28 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 11, paddingVertical: 6, borderRadius: 99 },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillLabel: { fontFamily: font.semibold, fontSize: 13, lineHeight: 13 },
  emptyRow: { minHeight: 56, paddingHorizontal: 18, alignItems: "center", justifyContent: "center" },
  emptyText: { fontFamily: font.regular, fontSize: 15 },
  fbar: { position: "absolute", left: 16, right: 16, bottom: 30, flexDirection: "row", gap: 6, padding: 6, borderRadius: 36, borderWidth: 1 },
  btn: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontFamily: font.regular, fontSize: 16 },
})

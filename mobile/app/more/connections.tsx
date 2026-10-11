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
import { Icon } from "@/components/icons"
import { Card, SectionHeader, ScreenHeader, ToastProvider } from "@/components/primitives"

// The Install button opens the web app's Connections page in the system
// browser. That page holds the real GitHub App install link; the mobile
// client never hardcodes an installation slug.
const CONNECTIONS_URL = `${process.env.EXPO_PUBLIC_API_BASE}/connections`

export default function ConnectionsScreen() {
  const { colors } = useTheme()
  const { data: rows, error } = useApiQuery<ConnectionRow[]>("/connections")
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

  // Group rows by account for the Installation header.
  // The mockup shows one installation, so we take the first account group.
  const firstAccount = rows && rows.length > 0 ? rows[0].account : null
  const repoCount = rows ? rows.length : 0

  const handleInstall = () => {
    Linking.openURL(CONNECTIONS_URL)
  }

  return (
    <ToastProvider>
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader title="Connections" back backLabel="Settings" />
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <Text style={[styles.h1, { color: colors.foreground }]}>Connections</Text>
          <Text style={[styles.hmeta, { color: colors.muted }]}>
            GitHub App installations and their repositories
          </Text>

          {/* Installation header */}
          <SectionHeader title="Installation" chevron={false} />
          <Card style={styles.card}>
            <Pressable
              onPress={handleInstall}
              style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}
              accessibilityLabel={`GitHub App installed by ${firstAccount}`}
            >
              <View style={styles.installRow}>
                <View style={[styles.avatar, { backgroundColor: colors.fill }]}>
                  <Icon name="github" size={20} stroke={colors.foreground} />
                </View>
                <View style={styles.installMain}>
                  <Text style={[styles.installTitle, { color: colors.foreground }]}>
                    {firstAccount ?? "Vaibhav91one"}
                  </Text>
                  <Text style={[styles.installSubtitle, { color: colors.muted }]}>
                    GitHub App installed · {repoCount} {repoCount === 1 ? "repository" : "repositories"}
                  </Text>
                </View>
                <Icon name="chev" size={18} stroke={colors.faint} />
              </View>
            </Pressable>
          </Card>

          {/* Repositories */}
          <SectionHeader title="Repositories" chevron={false} />
          <Card style={styles.card}>
            {rows && rows.length > 0 ? (
              rows.map((row) => (
                <RepoRow
                  key={row.id}
                  row={row}
                  onPress={() => router.push(`/more/connections/${row.repoId}`)}
                />
              ))
            ) : (
              <View style={[styles.emptyRow, { backgroundColor: colors.card }]}>
                <Text style={[styles.emptyText, { color: colors.muted }]}>No repositories connected</Text>
              </View>
            )}
          </Card>
          <Text style={[styles.note, { color: colors.muted }]}>
            Reproduction needs a bound target. A repository without one stops at analysis only.
          </Text>

          {/* Targets */}
          <SectionHeader title="Targets" chevron={false} />
          <Card style={styles.card}>
            <TargetLink
              icon="cube"
              title="View onboarding"
              subtitle="How a repository becomes a bound target"
              onPress={() => router.push("/more/onboarding")}
            />
            <View style={[styles.divider, { backgroundColor: colors.line }]} />
            <TargetLink
              icon="upload"
              title="Upload a target"
              subtitle="Archive, Dockerfile or prebuilt image"
              onPress={() => router.push("/more/submit-a-target")}
            />
          </Card>
          <Text style={[styles.note, { color: colors.muted }]}>
            Least privilege: Metadata, Issues and Repository security advisories. Contents read is
            added only for private repositories.
          </Text>
        </ScrollView>

        {/* Footer: Install GitHub App button */}
        <View style={[styles.fbar, { backgroundColor: colors.glass, borderColor: colors["glass-edge"] }]}>
          <Pressable
            onPress={handleInstall}
            style={({ pressed }) => [styles.btn, { backgroundColor: colors.brand, opacity: pressed ? 0.92 : 1 }]}
            accessibilityLabel="Install GitHub App"
          >
            <Text style={[styles.btnText, { color: colors.foreground }]}>Install GitHub App</Text>
          </Pressable>
        </View>
      </View>
    </ToastProvider>
  )
}

function RepoRow({ row, onPress }: { row: ConnectionRow; onPress: () => void }) {
  const { colors, phase } = useTheme()
  const pill = repoStatusPill(row, colors, phase)
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}>
      <View style={[styles.repoRow, { borderBottomColor: colors.line }]}>
        <View style={styles.repoMain}>
          <Text style={[styles.repoTitle, { color: colors.foreground }]}>{row.name}</Text>
          <Text style={[styles.repoSubtitle, { color: colors.muted }]}>{repoStatusHint(row)}</Text>
        </View>
        <StatusPill label={pill.label} color={pill.color} />
        <Icon name="chev" size={18} stroke={colors.faint} />
      </View>
    </Pressable>
  )
}

function repoStatusPill(
  row: ConnectionRow,
  colors: { red: string },
  phase: { delivered: string; closed: string },
): { label: string; color: string } {
  if (row.status === "suspended" || row.status === "archived" || row.status === "disconnected")
    return { label: "Policy refused", color: colors.red }
  if (row.configured) return { label: "Target bound", color: phase.delivered }
  return { label: "No target", color: phase.closed }
}

function repoStatusHint(row: ConnectionRow): string {
  if (row.status === "suspended" || row.status === "archived" || row.status === "disconnected")
    return row.isPrivate ? "Private" : "Suspended"
  if (row.configured && row.target) {
    // Mockup shows "Public · <target>" for bound repos.
    return (row.isPrivate ? "Private" : "Public") + " · " + row.target
  }
  // Not configured, not bound: mockup shows "Public · main"
  return (row.isPrivate ? "Private" : "Public") + " · main"
}

function StatusPill({ label, color }: { label: string; color: string }) {
  const tint = color + "29"
  return (
    <View style={[styles.pill, { backgroundColor: tint, borderColor: tint }]}>
      <View style={[styles.pillDot, { backgroundColor: color }]} />
      <Text style={[styles.pillLabel, { color }]}>{label}</Text>
    </View>
  )
}

function TargetLink({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: string
  title: string
  subtitle: string
  onPress: () => void
}) {
  const { colors } = useTheme()
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}>
      <View style={styles.targetLink}>
        <View style={[styles.avatar, { backgroundColor: colors.fill }]}>
          <Icon name={icon as any} size={20} stroke={colors.foreground} />
        </View>
        <View style={styles.targetLinkMain}>
          <Text style={[styles.repoTitle, { color: colors.foreground }]}>{title}</Text>
          <Text style={[styles.repoSubtitle, { color: colors.muted }]}>{subtitle}</Text>
        </View>
        <Icon name="chev" size={18} stroke={colors.faint} />
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { paddingTop: 6, paddingBottom: 100 },
  h1: { fontSize: 28, fontWeight: "700", letterSpacing: -0.03 * 28, lineHeight: 32, paddingHorizontal: 20, paddingTop: 16 },
  hmeta: { fontSize: 15, lineHeight: 20, paddingHorizontal: 20, marginBottom: 12 },
  card: { marginHorizontal: 16, borderRadius: 24, overflow: "hidden", marginBottom: 4 },
  installRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 18,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  installMain: { flex: 1, minWidth: 0 },
  installTitle: { fontSize: 17, fontWeight: "500", lineHeight: 20 },
  installSubtitle: { fontSize: 13, marginTop: 3 },
  repoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  repoMain: { flex: 1, minWidth: 0 },
  repoTitle: { fontSize: 17, fontWeight: "500", lineHeight: 20 },
  repoSubtitle: { fontSize: 13, marginTop: 3 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 99,
  },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillLabel: { fontSize: 13, fontWeight: "600", lineHeight: 14 },
  targetLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 18,
  },
  targetLinkMain: { flex: 1, minWidth: 0 },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 18 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 20, marginTop: 10 },
  emptyRow: { minHeight: 56, paddingHorizontal: 18, alignItems: "center", justifyContent: "center" },
  emptyText: { fontSize: 15 },
  fbar: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 30,
    flexDirection: "row",
    gap: 6,
    padding: 6,
    borderRadius: 36,
    borderWidth: StyleSheet.hairlineWidth,
  },
  btn: {
    flex: 1,
    minHeight: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 22,
    // backgroundColor moved to inline style below (theme token)
  },
  btnText: { fontSize: 17, fontWeight: "600" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontSize: 16 },
})

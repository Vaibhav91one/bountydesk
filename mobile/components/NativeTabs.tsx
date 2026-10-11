/**
 * NativeTabs shell chrome — the Variant C floating tab dock.
 *
 * Matches docs/site/screens/m4.html navigation chrome and native-ui.html:
 * - A glass top bar (GlassPill) holding the bell (Inbox) and a more menu.
 * - The more menu opens Settings (M19), Connections (M14), Integrations (M16).
 * - A floating tab pill at the bottom: Home, Queue, Reports.
 * - A separate 64pt round Review button beside the tab pill, with a count badge
 *   that opens sign/[id] for the next waiting verdict (or Connections on first run).
 *
 * The tab routes are peers with no slide transition, rendered here as a custom
 * dock to match c.js's TABS constant exactly.
 */
import { useState } from "react"
import { View, Text, StyleSheet, Pressable, Modal } from "react-native"
import { LinearGradient } from "expo-linear-gradient"
import { useRouter, usePathname, Slot } from "expo-router"
import { Icon } from "@/components/icons"
import type { IconName } from "@/components/icons"
import { GlassPill } from "@/components/primitives"
import { useTheme } from "@/theme"

const TABS: { key: string; label: string; icon: IconName; route: string }[] = [
  { key: "home", label: "Home", icon: "home", route: "/(tabs)" },
  { key: "queue", label: "Queue", icon: "queue", route: "/(tabs)/queue" },
  { key: "reports", label: "Reports", icon: "reports", route: "/(tabs)/reports" },
]

const MORE_ITEMS: { label: string; icon: IconName; route: string }[] = [
  { label: "Settings", icon: "cog", route: "/(tabs)/more" },
  { label: "Connections", icon: "github", route: "/(tabs)/more/connections" },
  { label: "Integrations", icon: "mail", route: "/(tabs)/more/integrations" },
]

export interface NativeTabsProps {
  /** count of verdicts waiting a decision, shown on the Review badge */
  reviewCount?: number
  /** first-run flag: on first run the Review FAB opens Connections instead */
  firstRun?: boolean
}

function MoreMenu({ open, onClose, onRoute }: { open: boolean; onClose: () => void; onRoute: (r: string) => void }) {
  const { colors } = useTheme()
  if (!open) return null
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose} hardwareAccelerated>
      <Pressable style={styles.moreScrims} onPress={onClose}>
        <View style={[styles.moreMenu, { backgroundColor: colors.sheet, borderColor: colors["glass-edge"] }]}>
          {MORE_ITEMS.map((it) => (
            <Pressable
              key={it.route}
              style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, styles.moreItem]}
              onPress={() => {
                onRoute(it.route)
                onClose()
              }}
            >
              <Icon name={it.icon} size={20} stroke={colors.muted} />
              <Text style={[styles.moreLabel, { color: colors.foreground }]}>{it.label}</Text>
            </Pressable>
          ))}
        </View>
      </Pressable>
    </Modal>
  )
}

export function NativeTabsShell({ reviewCount = 3, firstRun = false }: NativeTabsProps) {
  const { colors, round } = useTheme()
  const router = useRouter()
  const pathname = usePathname()

  const activeTab = pathname.startsWith("/(tabs)/reports") ? "reports"
    : pathname.startsWith("/(tabs)/queue") ? "queue"
    : "home"

  const [moreOpen, setMoreOpen] = useState(false)
  const go = (r: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(router as any).replace(r)
  }

  const openReview = () => {
    if (firstRun) {
      go("/(tabs)/more/connections")
      return
    }
    // Open the next waiting verdict; ROUTES.md maps sign/[id] -> M11.
    go("/reports/BD-1042/sign-the-verdict")
  }

  return (
    <View style={[styles.shellContainer, { backgroundColor: colors.background }]}>
      {/* Top bar: bell (Inbox) + more menu in a glass pill */}
      <GlassPill style={styles.topBar} round>
        <Pressable
          onPress={() => go("/(tabs)/inbox")}
          style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, styles.topBtn]}
          aria-label="Inbox"
        >
          <Icon name="bell" size={22} stroke={colors.foreground} />
        </Pressable>
        <Pressable
          onPress={() => setMoreOpen(true)}
          style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, styles.topBtn]}
          aria-label="More"
        >
          <Icon name="more" size={22} stroke={colors.foreground} />
        </Pressable>
      </GlassPill>

      {/* Page content */}
      <View style={styles.content}>
        <Slot />
      </View>

      {/* Bottom dock: floating tab pill + Review FAB */}
      <View style={styles.dock}>
        <LinearGradient
          colors={[colors.glass, colors.glass]}
          style={[styles.tabsContainer, { borderRadius: round.tabPillRadius }]}
        >
          {TABS.map((tab) => {
            const isActive = activeTab === tab.key
            return (
              <Pressable
                key={tab.key}
                onPress={() => go(tab.route)}
                style={[
                  styles.tab,
                  isActive && { backgroundColor: colors.fill },
                ]}
              >
                <Icon
                  name={tab.icon}
                  size={24}
                  stroke={isActive ? colors.brand : colors.muted}
                />
                <Text style={[styles.tabLabel, { color: isActive ? colors.foreground : colors.muted }]}>{tab.label}</Text>
              </Pressable>
            )
          })}
        </LinearGradient>

        {/* Review FAB — separate 64pt round button with count badge */}
        <Pressable onPress={openReview} style={styles.fab} accessibilityLabel="Review next verdict">
          <LinearGradient
            colors={[colors.brand, colors.brand]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.fabInner}
          >
            <Icon name="check" size={28} stroke="#ffffff" strokeWidth={2.2} />
            {reviewCount > 0 ? (
              <View style={[styles.fabBadge, { backgroundColor: colors.background }]}>
                <Text style={styles.fabBadgeText}>{reviewCount}</Text>
              </View>
            ) : null}
          </LinearGradient>
        </Pressable>
      </View>

      <MoreMenu open={moreOpen} onClose={() => setMoreOpen(false)} onRoute={go} />
    </View>
  )
}

const styles = StyleSheet.create({
  shellContainer: { flex: 1 },
  topBar: {
    position: "absolute",
    top: 54,
    right: 16,
    zIndex: 30,
    flexDirection: "row",
    gap: 8,
  },
  topBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    flex: 1,
    marginTop: 54 + 48,
    marginBottom: 120,
  },
  dock: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 30,
    zIndex: 30,
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
  },
  tabsContainer: {
    flex: 1,
    height: 64,
    padding: 6,
    gap: 2,
    flexDirection: "row",
  },
  tab: {
    flex: 1,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  tabLabel: {
    fontSize: 12,
    fontWeight: "500",
  },
  fab: {
    width: 64,
    height: 64,
    borderRadius: 32,
    flexShrink: 0,
  },
  fabInner: {
    width: "100%",
    height: "100%",
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  fabBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  fabBadgeText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
  moreScrims: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-start", paddingTop: 110, alignItems: "flex-end", paddingRight: 16 },
  moreMenu: { minWidth: 180, borderRadius: 20, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, gap: 4 },
  moreItem: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  moreLabel: { fontSize: 17, fontWeight: "600", lineHeight: 22 },
})

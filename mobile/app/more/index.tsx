/** M19 Settings. Account, theme, notification toggles, workspace links, legal, sign out.
 * Matches docs/site/screens/m19.html exactly.
 *
 * Theme cycles System, Light, Dark. Notification switches are stored locally via
 * AsyncStorage (push wiring comes later). Sign out calls signOutAndClear which
 * tears the persisted query cache before ending the Clerk session.
 */
import { useState, useEffect } from "react"
import { View, Text, ScrollView, StyleSheet, Pressable } from "react-native"
import { useRouter } from "expo-router"
import { useAuth } from "@clerk/expo"
import AsyncStorage from "@react-native-async-storage/async-storage"
import { useApiQuery, ApiError } from "@/lib/use-query"
import type { MobileMe } from "@/lib/types"
import { useTheme } from "@/theme"
import { ScreenHeader, Card, useToast } from "@/components/primitives"
import { Icon } from "@/components/icons"
import type { IconName } from "@/components/icons"
import { signOutAndClear } from "@/lib/session"

const THEME_ORDER: ("system" | "light" | "dark")[] = ["system", "light", "dark"]
const THEME_LABELS = { system: "System", light: "Light", dark: "Dark" }

const WORKSPACE_ITEMS: { label: string; subtitle: string; icon: IconName; route: string }[] = [
  { label: "Connections", subtitle: "GitHub App and repositories", icon: "github", route: "/more/connections" },
  { label: "Integrations", subtitle: "Email access", icon: "mail", route: "/more/integrations" },
  { label: "Target and scope", subtitle: "juice-shop v17.3.0", icon: "target", route: "/more/target-and-scope" },
]

const ABOUT_ITEMS: { label: string; icon: IconName; route: string }[] = [
  { label: "Privacy", icon: "lock", route: "/more/privacy" },
  { label: "Terms", icon: "file", route: "/more/terms" },
]

const NOTIFICATION_TOGGLES = [
  { key: "approvals", label: "Approvals needed", icon: "bell" as IconName, default: true },
  { key: "delivery", label: "Delivery receipts", icon: "check" as IconName, default: true },
  { key: "repro", label: "Reproduction failures", icon: "info" as IconName, default: false },
]

const NOTIF_STORAGE_KEY = "bountydesk:notifications"

export default function SettingsScreen() {
  const { colors } = useTheme()
  const router = useRouter()
  const { show } = useToast()
  const { signOut } = useAuth()
  const me = useApiQuery<MobileMe>("/me")

  const [themeMode, setThemeMode] = useState<"system" | "light" | "dark">("system")
  const [notifToggles, setNotifToggles] = useState<Record<string, boolean>>({})

  // Load persisted notification toggles on mount.
  useEffect(() => {
    AsyncStorage.getItem(NOTIF_STORAGE_KEY).then((raw) => {
      if (raw) {
        try {
          setNotifToggles(JSON.parse(raw))
        } catch {
          // fall back to defaults
        }
      } else {
        const defaults: Record<string, boolean> = {}
        NOTIFICATION_TOGGLES.forEach((t) => {
          defaults[t.key] = t.default
        })
        setNotifToggles(defaults)
      }
    })
  }, [])

  // Persist notification toggles whenever they change.
  useEffect(() => {
    if (Object.keys(notifToggles).length > 0) {
      AsyncStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(notifToggles)).catch(() => {})
    }
  }, [notifToggles])

  const isAuthError = me.error instanceof ApiError && (me.error.status === 401 || me.error.status === 403)
  if (isAuthError) return null

  const cycleTheme = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(themeMode) + 1) % THEME_ORDER.length]
    setThemeMode(next)
    show("Theme")
  }

  const toggleNotif = (key: string) => {
    setNotifToggles((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const handleSignOut = async () => {
    await signOutAndClear(() => signOut())
    router.replace("/auth/splash")
  }

  const handlePress = (route: string) => {
    router.push(route)
  }

  const user = me.data
  const initials = user?.allowlisted === true && user.login ? user.login.charAt(0).toUpperCase() : "?"
  const userName = user?.allowlisted === true ? (user.login ?? "") : "Guest"
  const userEmail = user?.allowlisted === true ? (user.email ?? "") : ""
  const userRole = user?.allowlisted === true ? user.role : "read_only"

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Settings" back backLabel="Home" />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        <Text style={[styles.h1, { color: colors.foreground }]}>Settings</Text>
        <Text style={[styles.hmeta, { color: colors.muted }]}>Account and workspace</Text>

        {/* Account row */}
        <View style={styles.section}>
          <Card style={styles.list}>
            <View style={[styles.item, styles.accountItem, { backgroundColor: colors.card }]}>
              <View style={styles.rowLeading}>
                <View style={[styles.avatar, { backgroundColor: colors.brand + "29" }]}>
                  <Text style={[styles.avatarText, { color: colors.brand }]}>{initials}</Text>
                </View>
              </View>
              <View style={styles.main}>
                <Text style={[styles.itemT, { color: colors.foreground }]}>{userName}</Text>
                <Text style={[styles.itemS, { color: colors.muted }]}>{userEmail}</Text>
              </View>
              <View style={styles.rowTrailing}>
                <View style={[styles.pill, { backgroundColor: colors.brand + "29" }]}>
                  <View style={[styles.pillDot, { backgroundColor: colors.brand }]} />
                  <Text style={[styles.pillLabel, { color: colors.brand }]}>
                    {userRole === "owner" ? "Owner" : userRole === "member" ? "Reviewer" : "Read-only"}
                  </Text>
                </View>
              </View>
            </View>
          </Card>
        </View>

        {/* Appearance section */}
        <View style={styles.section}>
          <View style={styles.sh}>
            <Text style={[styles.shText, { color: colors.foreground }]}>Appearance</Text>
          </View>
          <Card style={styles.list}>
            <Pressable
              onPress={cycleTheme}
              style={({ pressed }) => [styles.item, { backgroundColor: colors.card }, pressed && { opacity: 0.92 }]}
            >
              <View style={styles.rowLeading}>
                <Icon name="cog" size={20} stroke={colors["brand-soft"]} />
              </View>
              <View style={styles.main}>
                <Text style={[styles.itemT, { color: colors.foreground }]}>Theme</Text>
              </View>
              <View style={styles.rowTrailing}>
                <Text style={[styles.value, { color: colors.foreground }]}>{THEME_LABELS[themeMode]}</Text>
                <Icon name="chev" size={18} stroke={colors.faint} />
              </View>
            </Pressable>
          </Card>
        </View>

        {/* Notification section */}
        <View style={styles.section}>
          <View style={styles.sh}>
            <Text style={[styles.shText, { color: colors.foreground }]}>Notification</Text>
          </View>
          <Card style={styles.list}>
            {NOTIFICATION_TOGGLES.map((t) => (
              <View key={t.key} style={[styles.switchRow, { backgroundColor: colors.card }]}>
                <View style={styles.rowLeading}>
                  <Icon name={t.icon} size={20} stroke={colors["brand-soft"]} />
                </View>
                <View style={styles.main}>
                  <Text style={[styles.itemT, { color: colors.foreground }]}>{t.label}</Text>
                </View>
                <Pressable
                  onPress={() => toggleNotif(t.key)}
                  style={[
                    styles.switch,
                    (notifToggles[t.key] ?? t.default) && { backgroundColor: colors.brand },
                  ]}
                  role="switch"
                  aria-checked={notifToggles[t.key] ?? t.default}
                >
                  <View
                    style={[
                      styles.switchKnob,
                      { backgroundColor: colors.foreground },
                      (notifToggles[t.key] ?? t.default) && { transform: [{ translateX: 20 }] },
                    ]}
                  />
                </Pressable>
              </View>
            ))}
          </Card>
          <Text style={[styles.note, { color: colors.muted }]}>
            Push shows a report id and short title only, never the verdict text.
          </Text>
        </View>

        {/* Workspace section */}
        <View style={styles.section}>
          <View style={styles.sh}>
            <Text style={[styles.shText, { color: colors.foreground }]}>Workspace</Text>
          </View>
          <Card style={styles.list}>
            {WORKSPACE_ITEMS.map((item) => (
              <Pressable
                key={item.route}
                onPress={() => handlePress(item.route)}
                style={({ pressed }) => [styles.item, { backgroundColor: colors.card }, pressed && { opacity: 0.92 }]}
              >
                <View style={styles.rowLeading}>
                  <Icon name={item.icon} size={20} stroke={colors["brand-soft"]} />
                </View>
                <View style={styles.main}>
                  <Text style={[styles.itemT, { color: colors.foreground }]}>{item.label}</Text>
                  <Text style={[styles.itemS, { color: colors.muted }]}>{item.subtitle}</Text>
                </View>
                <View style={styles.rowTrailing}>
                  <Icon name="chev" size={18} stroke={colors.faint} />
                </View>
              </Pressable>
            ))}
          </Card>
        </View>

        {/* About section */}
        <View style={styles.section}>
          <View style={styles.sh}>
            <Text style={[styles.shText, { color: colors.foreground }]}>About</Text>
          </View>
          <Card style={styles.list}>
            {ABOUT_ITEMS.map((item) => (
              <Pressable
                key={item.route}
                onPress={() => handlePress(item.route)}
                style={({ pressed }) => [styles.item, { backgroundColor: colors.card }, pressed && { opacity: 0.92 }]}
              >
                <View style={styles.rowLeading}>
                  <Icon name={item.icon} size={20} stroke={colors["brand-soft"]} />
                </View>
                <View style={styles.main}>
                  <Text style={[styles.itemT, { color: colors.foreground }]}>{item.label}</Text>
                </View>
                <View style={styles.rowTrailing}>
                  <Icon name="chev" size={18} stroke={colors.faint} />
                </View>
              </Pressable>
            ))}
          </Card>
          <Text style={[styles.note, { color: colors.muted }]}>Version 0.1.0 · proposed mobile app, not built</Text>
        </View>

        {/* Sign out */}
        <View style={styles.section}>
          <Card style={styles.list}>
            <Pressable
              onPress={handleSignOut}
              style={({ pressed }) => [styles.item, styles.signOutItem, { backgroundColor: colors.card }, pressed && { opacity: 0.92 }]}
            >
              <Text style={[styles.signOutText, { color: colors.red }]}>Sign out</Text>
            </Pressable>
          </Card>
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: {
    paddingTop: 62,
    paddingBottom: 40,
  },
  h1: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.03 * 28,
    lineHeight: 32,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  hmeta: {
    fontSize: 15,
    lineHeight: 20,
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  section: {
    marginBottom: 28,
  },
  sh: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  shText: {
    fontSize: 20,
    fontWeight: "600",
    lineHeight: 24,
  },
  list: {
    marginHorizontal: 16,
    borderRadius: 24,
    overflow: "hidden",
    padding: 0,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  accountItem: {
    minHeight: 72,
    paddingVertical: 12,
  },
  rowLeading: {
    paddingLeft: 0,
    paddingRight: 12,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 50,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: 16,
    fontWeight: "600",
  },
  main: {
    flex: 1,
    minWidth: 0,
  },
  itemT: {
    fontSize: 17,
    fontWeight: "500",
    lineHeight: 20,
  },
  itemS: {
    fontSize: 13,
    marginTop: 3,
  },
  rowTrailing: {
    paddingLeft: 12,
    paddingRight: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  value: {
    fontSize: 17,
    fontWeight: "500",
    lineHeight: 20,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 99,
  },
  pillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  pillLabel: {
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 14,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  switch: {
    width: 51,
    height: 31,
    borderRadius: 16,
    backgroundColor: "rgba(0,0,0,0.3)",
    position: "relative",
    flexShrink: 0,
  },
  switchKnob: {
    width: 27,
    height: 27,
    borderRadius: 14,
    position: "absolute",
    top: 2,
    left: 2,
  },
  signOutItem: {
    justifyContent: "center",
  },
  signOutText: {
    fontWeight: "600",
    lineHeight: 20,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 20,
    marginTop: 10,
  },
})

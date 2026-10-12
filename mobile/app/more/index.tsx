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
import { useAuth } from "@/lib/auth-hooks"
import AsyncStorage from "@react-native-async-storage/async-storage"
import { useApiQuery, ApiError } from "@/lib/use-query"
import type { MobileMe } from "@/lib/types"
import { useTheme } from "@/theme"
import { ScreenHeader, ScreenTitle, PhasePill, useToast } from "@/components/primitives"
import { ListCard, SectionHead } from "@/components/ReportList"
import { BottomFade, ItemLine, Note } from "@/components/CaseUi"
import { fixturesEnabled } from "@/lib/fixtures"
import { Icon } from "@/components/icons"
import type { IconName } from "@/components/icons"
import { signOutAndClear } from "@/lib/session"
import { font } from "@/lib/fonts"


const WORKSPACE_ITEMS: { label: string; subtitle: string; icon: IconName; route: string }[] = [
  { label: "Connections", subtitle: "GitHub App and repositories", icon: "github", route: "/more/connections" },
  { label: "Integrations", subtitle: "Email access", icon: "mail", route: "/more/integrations" },
]

/** The iOS-style switch of c.css .switch: a 51x31 track with a 27 knob that slides 20 when on. */
function Switch({ on, onPress, label }: { on: boolean; onPress: () => void; label: string }) {
  const { colors } = useTheme()
  return (
    <Pressable
      onPress={onPress}
      role="switch"
      aria-checked={on}
      accessibilityLabel={label}
      style={[styles.switch, { backgroundColor: on ? colors.brand : "#77777773" }]}
    >
      <View style={[styles.switchKnob, on && { transform: [{ translateX: 20 }] }]} />
    </Pressable>
  )
}

const initialsOf = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("") || "?"

const ABOUT_ITEMS: { label: string; icon: IconName; route: string }[] = [
  { label: "Privacy", icon: "lock", route: "/more/privacy" },
  { label: "Terms", icon: "file", route: "/more/terms" },
]

const NOTIFICATION_TOGGLES = [
  { key: "approvals", label: "Approvals needed", icon: "bell" as IconName, default: fixturesEnabled() },
  { key: "delivery", label: "Delivery receipts", icon: "check" as IconName, default: fixturesEnabled() },
  { key: "repro", label: "Reproduction failures", icon: "info" as IconName, default: false },
]

const NOTIF_STORAGE_KEY = "bountydesk:notifications"

export default function SettingsScreen() {
  const { colors } = useTheme()
  const router = useRouter()
  const { show } = useToast()
  const { signOut } = useAuth()
  const me = useApiQuery<MobileMe>("/me")

  const [notifToggles, setNotifToggles] = useState<Record<string, boolean>>({})

  // Load persisted notification toggles on mount.
  useEffect(() => {
    AsyncStorage.getItem(NOTIF_STORAGE_KEY).then((raw) => {
      // Fixture mode always starts from the mockup's switch states, not whatever an earlier run saved.
      if (raw && !fixturesEnabled()) {
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

  const toggleNotif = async (key: string) => {
    const turningOn = !notifToggles[key]
    setNotifToggles((prev) => ({ ...prev, [key]: turningOn }))
    if (key !== "approvals" && key !== "delivery") return
    // Lazy so the native push modules are only loaded when a switch is used, not on mount.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerForPush, unregisterPush } = require("@/lib/push")
    if (turningOn) {
      let reason: string | null = null
      try {
        const result = await registerForPush()
        if (!result.ok) reason = result.reason
      } catch (e) {
        reason = e instanceof Error ? e.message : "Could not turn on notifications"
      }
      if (reason) {
        show(reason)
        setNotifToggles((prev) => ({ ...prev, [key]: false }))
      }
      return
    }
    // The server sends both kinds to every registered device, so the device only stops
    // receiving pushes once both switches are off.
    const other = key === "approvals" ? "delivery" : "approvals"
    if (!notifToggles[other]) await unregisterPush().catch(() => {})
  }

  const handleSignOut = async () => {
    await signOutAndClear(() => signOut())
    router.replace("/auth/splash")
  }

  const handlePress = (route: string) => {
    router.push(route)
  }

  const user = me.data
  const initials = user?.allowlisted === true && user.login ? initialsOf(user.login) : "?"
  const userName = user?.allowlisted === true ? (user.login ?? "") : "Guest"
  const userEmail = user?.allowlisted === true ? (user.email ?? "") : ""
  const userRole = user?.allowlisted === true ? user.role : "read_only"

  const chev = <Icon name="chev" size={18} stroke={colors.faint} />
  const lead = (name: IconName) => <Icon name={name} size={22} stroke={colors["brand-soft"]} />

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader back backLabel="Home" />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        <ScreenTitle title="Settings" meta="Account and workspace" metaBottom={20} />

        <View style={styles.sect}>
          <ListCard>
            <ItemLine
              minHeight={72}
              title={userName}
              subtitle={userEmail}
              leading={
                <View style={[styles.avatar, { backgroundColor: colors.brand + "38" }]}>
                  <Text style={[styles.avatarText, { color: colors["brand-soft"] }]}>{initials}</Text>
                </View>
              }
              trailing={<PhasePill phase={userRole === "read_only" ? "closed" : "delivered"} label={userRole === "read_only" ? "Read-only" : "Reviewer"} />}
            />
          </ListCard>
        </View>

        <View style={styles.sect}>
          <SectionHead title="Notifications" />
          <ListCard>
            {NOTIFICATION_TOGGLES.map((t, i) => (
              <ItemLine
                key={t.key}
                divider={i > 0}
                title={t.label}
                leading={lead(t.icon)}
                trailing={<Switch on={notifToggles[t.key] ?? t.default} onPress={() => toggleNotif(t.key)} label={t.label} />}
              />
            ))}
          </ListCard>
          <Note>Push shows a report id and short title only, never the verdict text.</Note>
        </View>

        <View style={styles.sect}>
          <SectionHead title="Workspace" />
          <ListCard>
            {WORKSPACE_ITEMS.map((item, i) => (
              <Pressable key={item.route} onPress={() => handlePress(item.route)} style={({ pressed }) => pressed && { opacity: 0.92 }}>
                <ItemLine divider={i > 0} title={item.label} subtitle={item.subtitle} leading={lead(item.icon)} trailing={chev} />
              </Pressable>
            ))}
          </ListCard>
        </View>

        <View style={styles.sect}>
          <SectionHead title="About" />
          <ListCard>
            {ABOUT_ITEMS.map((item, i) => (
              <Pressable key={item.route} onPress={() => handlePress(item.route)} style={({ pressed }) => pressed && { opacity: 0.92 }}>
                <ItemLine divider={i > 0} title={item.label} leading={lead(item.icon)} trailing={chev} />
              </Pressable>
            ))}
          </ListCard>
          <Note>Version 0.1.0 · proposed mobile app, not built</Note>
        </View>

        <View style={styles.sect}>
          <ListCard>
            <Pressable onPress={handleSignOut} style={({ pressed }) => [styles.signOut, pressed && { opacity: 0.92 }]}>
              <Text style={[styles.signOutText, { color: colors.red }]}>Sign out</Text>
            </Pressable>
          </ListCard>
        </View>
      </ScrollView>
      <BottomFade />
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 150 },
  sect: { marginBottom: 28 },
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  avatarText: { fontFamily: font.semibold, fontSize: 16, lineHeight: 16 },
  switch: { width: 51, height: 31, borderRadius: 16, flexShrink: 0 },
  switchKnob: { position: "absolute", top: 2, left: 2, width: 27, height: 27, borderRadius: 14, backgroundColor: "#fff", boxShadow: "0 2px 4px rgba(0,0,0,0.3)" },
  signOut: { minHeight: 56, alignItems: "center", justifyContent: "center", paddingVertical: 10, paddingHorizontal: 18 },
  signOutText: { fontFamily: font.semibold, fontSize: 17, lineHeight: 22.95, letterSpacing: -0.187 },
})

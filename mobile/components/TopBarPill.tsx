/**
 * The glass top-right pill: bell (Inbox, m23) and a more menu that opens
 * Settings (m19), Connections (m14) and Integrations (m16).
 *
 * Per docs/site/native-ui.html these are chrome, not tabs. Rendered above the
 * tab bar on the three tab screens only.
 */
import { useState } from "react"
import { View, Text, Pressable, Modal, StyleSheet } from "react-native"
import { useRouter } from "expo-router"
import { Icon } from "@/components/icons"
import { GlassPill } from "@/components/primitives"
import { useTheme } from "@/theme"

const MENU_ITEMS: { label: string; icon: IconName; route: string }[] = [
  { label: "Settings", icon: "cog", route: "/more" },
  { label: "Connections", icon: "github", route: "/more/connections" },
  { label: "Integrations", icon: "mail", route: "/more/integrations" },
]

type IconName = "cog" | "github" | "mail" | "bell" | "more"

export function TopBarPill() {
  const { colors } = useTheme()
  const router = useRouter()
  const [open, setOpen] = useState(false)

  const go = (r: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(router as any).push(r)
    setOpen(false)
  }

  return (
    <>
      <GlassPill style={styles.pill} round>
        <Pressable onPress={() => go("/inbox")} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, styles.btn]} aria-label="Inbox">
          <Icon name="bell" size={22} stroke={colors.foreground} />
        </Pressable>
        <Pressable onPress={() => setOpen(true)} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, styles.btn]} aria-label="More">
          <Icon name="more" size={22} stroke={colors.foreground} />
        </Pressable>
      </GlassPill>

      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)} hardwareAccelerated>
        <Pressable style={styles.scrims} onPress={() => setOpen(false)}>
          <View style={[styles.menu, { backgroundColor: colors.sheet, borderColor: colors["glass-edge"] }]}>
            {MENU_ITEMS.map((it) => (
              <Pressable key={it.route} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, styles.item]} onPress={() => go(it.route)}>
                <Icon name={it.icon} size={20} stroke={colors.muted} />
                <Text style={[styles.label, { color: colors.foreground }]}>{it.label}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  pill: {
    position: "absolute",
    top: 54,
    right: 16,
    zIndex: 30,
    flexDirection: "row",
    gap: 8,
  },
  btn: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  scrims: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-start", paddingTop: 110, alignItems: "flex-end", paddingRight: 16 },
  menu: { minWidth: 180, borderRadius: 20, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, gap: 4 },
  item: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  label: { fontSize: 17, fontWeight: "600", lineHeight: 22 },
})

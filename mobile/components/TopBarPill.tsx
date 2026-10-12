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
import { TopBar, TopBarButton, TopFade } from "@/components/primitives"
import { useTheme } from "@/theme"
import { font } from "@/lib/fonts"

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
      <View pointerEvents="box-none" style={styles.chrome}>
        <TopFade />
        <TopBar side="right">
          <TopBarButton icon="bell" label="Inbox" onPress={() => go("/inbox")} />
          <TopBarButton icon="more" label="More" onPress={() => setOpen(true)} />
        </TopBar>
      </View>

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
  chrome: { position: "absolute", top: 0, left: 0, right: 0, height: 124, zIndex: 30 },
  scrims: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-start", paddingTop: 110, alignItems: "flex-end", paddingRight: 16 },
  menu: { minWidth: 180, borderRadius: 20, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, gap: 4 },
  item: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  label: { fontFamily: font.semibold, fontSize: 17, lineHeight: 22 },
})

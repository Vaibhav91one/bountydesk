/**
 * The bottom dock (c.css .dock/.tabs/.tab): a left-aligned glass pill with Home, Queue and
 * Reports, and the Review next button beside it. Drawn by hand because the iOS system tab bar
 * is centred and cannot take this shape.
 */
import { View, Text, Pressable, StyleSheet } from "react-native"
import type { BottomTabBarProps } from "expo-router/js-tabs"
import { Icon, type IconName } from "@/components/icons"
import { ReviewFab } from "@/components/ReviewFab"
import { useTheme } from "@/theme"
import { GlassBlur } from "@/components/GlassBlur"
import { font } from "@/lib/fonts"

const TABS: { route: string; label: string; icon: IconName }[] = [
  { route: "index", label: "Home", icon: "home" },
  { route: "queue", label: "Queue", icon: "queue" },
  { route: "reports", label: "Reports", icon: "reports" },
]

export function TabDock({ state, navigation }: BottomTabBarProps) {
  const { colors } = useTheme()
  const current = state.routes[state.index]?.name
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <ReviewFab />
      <View style={[styles.tabs, { backgroundColor: colors.glass, borderColor: colors["glass-edge"], overflow: "hidden" }]}><GlassBlur />
        {TABS.map((t) => {
          const route = state.routes.find((r) => r.name === t.route)
          if (!route) return null
          const on = current === t.route
          const color = on ? colors.foreground : colors.muted
          return (
            <Pressable
              key={t.route}
              accessibilityRole="tab"
              accessibilityLabel={t.label}
              accessibilityState={{ selected: on }}
              onPress={() => {
                const e = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true })
                if (!on && !e.defaultPrevented) navigation.navigate(route.name)
              }}
              style={[styles.tab, on && { backgroundColor: colors.fill }]}
            >
              <Icon name={t.icon} size={24} stroke={color} />
              <Text style={[styles.label, { color }]}>{t.label}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  tabs: {
    position: "absolute",
    left: 16,
    bottom: 30,
    zIndex: 30,
    width: 294,
    height: 64,
    borderRadius: 32,
    borderWidth: 1,
    padding: 6,
    gap: 2,
    flexDirection: "row",
  },
  tab: { flex: 1, borderRadius: 26, alignItems: "center", justifyContent: "center", gap: 2 },
  label: { fontFamily: font.medium, fontSize: 12, lineHeight: 16 },
})

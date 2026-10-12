/** c.css .menu.pop: a glass list anchored under the button that opened it, with a haptic on open. */
import { useEffect, useRef, type RefObject } from "react"
import { View, Text, Pressable, Modal, Animated, Easing, Dimensions, StyleSheet } from "react-native"
import * as Haptics from "expo-haptics"
import { BlurView } from "expo-blur"
import { Icon, type IconName } from "@/components/icons"
import { useTheme } from "@/theme"
import { font } from "@/lib/fonts"

export interface AnchorRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PopoverMenuItem {
  label: string
  /** trailing icon, as in the mockup's more menu */
  icon?: IconName
  onPress: () => void
}

const POP_WIDTH = 236

/** Measure a view's window rect, for anchoring a PopoverMenu to it. */
export function measureAnchor(ref: RefObject<View | null>, cb: (r: AnchorRect) => void) {
  ref.current?.measureInWindow((x, y, width, height) => cb({ x, y, width, height }))
}

export function PopoverMenu({ anchor, items, onClose }: { anchor: AnchorRect | null; items: PopoverMenuItem[]; onClose: () => void }) {
  const { colors } = useTheme()
  const t = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (!anchor) return
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
    t.setValue(0)
    Animated.timing(t, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start()
  }, [anchor, t])
  if (!anchor) return null
  const left = Math.max(12, Math.min(anchor.x + anchor.width - POP_WIDTH + 8, Dimensions.get("window").width - POP_WIDTH - 12))
  const top = anchor.y + anchor.height + 8
  // top-right transform origin: scale about the menu's right edge, then undo the centre offset
  const scale = t.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] })
  const shift = t.interpolate({ inputRange: [0, 1], outputRange: [POP_WIDTH * 0.05, 0] })
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close menu" />
      <Animated.View
        accessibilityRole="menu"
        style={[
          styles.popMenu,
          { left, top, backgroundColor: colors["sheet-card"] + "db", borderColor: colors["glass-edge"], opacity: t, transform: [{ translateX: shift }, { scale }] },
        ]}
      >
        <BlurView tint="dark" intensity={60} pointerEvents="none" style={StyleSheet.absoluteFill} />
        {items.map((it, i) => (
          <Pressable
            key={it.label}
            accessibilityRole="menuitem"
            onPress={() => {
              onClose()
              it.onPress()
            }}
            style={({ pressed }) => [styles.popItem, pressed && { backgroundColor: colors.fill }]}
          >
            {i > 0 ? <View style={[styles.popDivider, { backgroundColor: colors.line }]} /> : null}
            <Text style={[styles.popLabel, { color: colors.foreground }]}>{it.label}</Text>
            {it.icon ? <Icon name={it.icon} size={20} stroke={colors.muted} /> : null}
          </Pressable>
        ))}
      </Animated.View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  popMenu: { position: "absolute", width: POP_WIDTH, borderRadius: 22, overflow: "hidden", borderWidth: 1 },
  popItem: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 54, paddingHorizontal: 18 },
  popDivider: { position: "absolute", top: 0, left: 0, right: 0, height: 1 },
  popLabel: { fontFamily: font.regular, fontSize: 17, lineHeight: 22 },
})

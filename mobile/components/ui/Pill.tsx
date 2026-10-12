/**
 * Phase pill, matching .pill in c.css.
 * Tint is color-mix(in oklab,var(--c) 16%,transparent) with a 6px dot.
 * Since RN does not support color-mix(), we compute the tint by blending
 * the color with the card background at 16% opacity.
 */
import { StyleSheet, View, Text, ViewStyle } from "react-native"
import { font } from "@/lib/fonts"

export function Pill({
  label,
  color,
  children,
  style,
}: {
  label?: string
  color: string
  children?: React.ReactNode
  style?: ViewStyle
}) {
  // color-mix(in oklab,var(--c) 16%,transparent) approximates to 16% color on card bg
  const bg = color
  return (
    <View style={[styles.pill, { backgroundColor: bg + "29", borderColor: bg + "29" }, style]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color }]}>{children ?? label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 99,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {
    fontFamily: font.semibold, fontSize: 13,
    
    lineHeight: 14,
  },
})

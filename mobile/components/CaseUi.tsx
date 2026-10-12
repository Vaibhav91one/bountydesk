/**
 * Pieces the case-file screens (M7 to M10, M26) share: key/value and item rows with the inset
 * divider, the footnote, the bottom fade and the glass bar surface (c.css .kv, .item, .note,
 * .fade-b, .glass). Cards and section headers come from ReportList.
 */
import type { ReactNode } from "react"
import { View, Text, StyleSheet, type TextStyle } from "react-native"
import { LinearGradient } from "expo-linear-gradient"
import { useTheme } from "@/theme"
import { font } from "@/lib/fonts"

/** The 1px rule drawn above every row but the first, inset 18 on both sides. */
function Divider() {
  const { colors } = useTheme()
  return <View style={[styles.divider, { backgroundColor: colors.line }]} />
}

export function KvLine({ label, value, mono, strong, divider }: { label: string; value: string; mono?: boolean; strong?: boolean; divider?: boolean }) {
  const { colors } = useTheme()
  return (
    <View style={styles.kv}>
      {divider ? <Divider /> : null}
      <Text style={[styles.kvK, { color: colors.foreground }]}>{label}</Text>
      <Text
        style={[
          styles.kvV,
          { color: colors.muted },
          mono && { fontFamily: font.mono, fontSize: 14, letterSpacing: 0 },
          strong && { fontFamily: font.semibold },
        ]}
      >
        {value}
      </Text>
    </View>
  )
}

export interface ItemLineProps {
  title: string
  subtitle?: string
  /** title and subtitle in Geist Mono (the tool-call rows) */
  mono?: boolean
  trailing?: ReactNode
  divider?: boolean
}

/** Lets a long token wrap at any character, as the design's `word-break: break-all` does; RN only breaks at spaces. */
export const breakAnywhere = (text: string) => Array.from(text).join("\u200b")

export function ItemLine({ title, subtitle, mono, trailing, divider }: ItemLineProps) {
  const { colors } = useTheme()
  const t: TextStyle = mono ? { fontFamily: font.monoMedium, fontSize: 15, lineHeight: 18.6, letterSpacing: 0 } : {}
  const s: TextStyle = mono ? { fontFamily: font.mono, fontSize: 12, lineHeight: 18, letterSpacing: 0 } : {}
  return (
    <View style={styles.item}>
      {divider ? <Divider /> : null}
      <View style={styles.main}>
        <Text style={[styles.itemT, { color: colors.foreground }, t]} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.itemS, { color: colors.muted }, s]} numberOfLines={mono ? undefined : 1}>
            {mono ? breakAnywhere(subtitle) : subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
    </View>
  )
}

/** The plain trailing value of an item row (c.css .item .v). */
export function ItemValue({ children, strong }: { children: string; strong?: boolean }) {
  const { colors } = useTheme()
  return <Text style={[styles.itemV, { color: colors.muted }, strong && { fontFamily: font.semibold }]}>{children}</Text>
}

export function Note({ children }: { children: string }) {
  const { colors } = useTheme()
  return <Text style={[styles.note, { color: colors.muted }]}>{children}</Text>
}

/** Fades the scroll content out above a bottom bar (c.css .fade-b, 150 high). */
export function BottomFade() {
  const { colors } = useTheme()
  return (
    <LinearGradient
      pointerEvents="none"
      colors={[colors.background + "00", colors.background, colors.background]}
      locations={[0, 0.78, 1]}
      style={styles.fade}
    />
  )
}

const styles = StyleSheet.create({
  divider: { position: "absolute", top: 0, left: 18, right: 18, height: 1 },
  kv: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16, minHeight: 52, paddingVertical: 10, paddingHorizontal: 18 },
  kvK: { fontFamily: font.medium, fontSize: 17, lineHeight: 22.95, letterSpacing: -0.187 },
  kvV: { fontFamily: font.regular, fontSize: 17, lineHeight: 22.95, letterSpacing: -0.187, textAlign: "right", flexShrink: 1 },
  item: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 10, paddingHorizontal: 18 },
  main: { flex: 1, minWidth: 0 },
  itemT: { fontFamily: font.medium, fontSize: 17, lineHeight: 21.25, letterSpacing: -0.187 },
  itemS: { fontFamily: font.regular, fontSize: 13, lineHeight: 17.55, marginTop: 3 },
  itemV: { fontFamily: font.regular, fontSize: 17, lineHeight: 22.95, letterSpacing: -0.187 },
  note: { fontFamily: font.regular, fontSize: 13, lineHeight: 18.2, paddingTop: 10, paddingHorizontal: 20 },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: 150 },
})

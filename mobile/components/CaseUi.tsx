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
function Divider({ dashed }: { dashed?: boolean }) {
  const { colors } = useTheme()
  if (dashed) return <View style={[styles.divider, { height: 0, borderTopWidth: 1.5, borderStyle: "dashed", borderColor: colors.line }]} />
  return <View style={[styles.divider, { backgroundColor: colors.line }]} />
}

export function KvLine({ label, value, mono, strong, divider, dashed, trailing, stacked }: { label: string; value?: string; mono?: boolean; strong?: boolean; divider?: boolean; /** receipt cards draw a dashed rule (c.css .receipt) */ dashed?: boolean; /** replaces the value text, e.g. a pill */ trailing?: ReactNode; /** the value under the label instead of beside it (a long digest) */ stacked?: boolean }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.kv, stacked && styles.kvStacked]}>
      {divider ? <Divider dashed={dashed} /> : null}
      <Text style={[styles.kvK, { color: colors.foreground }]}>{label}</Text>
      {trailing ?? <Text
        style={[
          styles.kvV,
          { color: colors.muted },
          mono && { fontFamily: font.mono, fontSize: 14, lineHeight: 21, letterSpacing: 0 },
          stacked && styles.kvVStacked,
          strong && { fontFamily: font.semibold },
        ]}
      >
        {stacked && mono && value ? breakAnywhere(value) : value}
      </Text>}
    </View>
  )
}

export interface ItemLineProps {
  title: string
  subtitle?: string
  /** title and subtitle in Geist Mono (the tool-call rows) */
  mono?: boolean
  /** only the subtitle in Geist Mono, wrapping at any character (a digest under a plain title) */
  monoSubtitle?: boolean
  trailing?: ReactNode
  /** the avatar before the text (c.css .av) */
  leading?: ReactNode
  divider?: boolean
}

/** Lets a long token wrap at any character, as the design's `word-break: break-all` does; RN only breaks at spaces. */
export const breakAnywhere = (text: string) => Array.from(text).join("\u200b")

export function ItemLine({ title, subtitle, mono, monoSubtitle, trailing, leading, divider }: ItemLineProps) {
  const { colors } = useTheme()
  const t: TextStyle = mono ? { fontFamily: font.monoMedium, fontSize: 15, lineHeight: 18.6, letterSpacing: 0 } : {}
  const s: TextStyle = mono
    ? { fontFamily: font.mono, fontSize: 12, lineHeight: 18, letterSpacing: 0 }
    : monoSubtitle
      ? { fontFamily: font.mono, fontSize: 13, lineHeight: 19.5, letterSpacing: 0, marginTop: 4 }
      : {}
  return (
    <View style={styles.item}>
      {divider ? <Divider /> : null}
      {leading}
      <View style={styles.main}>
        <Text style={[styles.itemT, { color: colors.foreground }, t]} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.itemS, { color: colors.muted }, s]} numberOfLines={mono || monoSubtitle ? undefined : 1}>
            {mono || monoSubtitle ? breakAnywhere(subtitle) : subtitle}
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

/** The short commit in a build marker, which is the source commit baked into the image. */
export function shortCommit(marker: string | null | undefined): string | null {
  return marker?.match(/[0-9a-f]{7,40}/)?.[0].slice(0, 7) ?? null
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
  kvStacked: { flexDirection: "column", alignItems: "flex-start", justifyContent: "flex-start", gap: 4 },
  kvVStacked: { alignSelf: "stretch" },
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

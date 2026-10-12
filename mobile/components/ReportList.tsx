/**
 * The grouped list the three tab screens share: section header (c.css .sh), rounded card
 * (.card.list) and report row (.item.ev) with its phase pill and age.
 */
import { useRef, type ReactNode } from "react"
import { View, Text, Pressable, StyleSheet } from "react-native"
import { Icon } from "@/components/icons"
import { PhasePill, type PhaseKey } from "@/components/primitives"
import { measureAnchor, type AnchorRect } from "@/components/PopoverMenu"
import { useTheme } from "@/theme"
import { font } from "@/lib/fonts"

export interface SectionHeadProps {
  title: string
  count?: number | string
  /** opens the list this header summarises; adds the chevron */
  onPress?: () => void
  /** the "..." button at the right edge */
  onMore?: (anchor: AnchorRect) => void
}

export function SectionHead({ title, count, onPress, onMore }: SectionHeadProps) {
  const { colors } = useTheme()
  const moreRef = useRef<View>(null)
  const label = (
    <>
      <Text style={[styles.shTitle, { color: colors.foreground }]}>{title}</Text>
      {onPress ? <Icon name="chev" size={18} stroke={colors.muted} strokeWidth={2.4} /> : null}
      {count !== undefined ? <Text style={[styles.shCount, { color: colors.muted }]}>{count}</Text> : null}
    </>
  )
  return (
    <View style={styles.sh}>
      {onPress ? (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title} hitSlop={{ top: 12, bottom: 12 }} style={styles.shRow}>
          {label}
        </Pressable>
      ) : (
        <View style={styles.shRow}>{label}</View>
      )}
      {onMore ? (
        <Pressable ref={moreRef} onPress={() => measureAnchor(moreRef, onMore)} accessibilityRole="button" accessibilityLabel={`More options for ${title}`} style={styles.shMore}>
          <Icon name="more" size={22} stroke={colors.faint} />
        </Pressable>
      ) : null}
    </View>
  )
}

/** A surface holding rows: radius 24 with the 1px edge ring the mockups draw around cards. */
export function ListCard({ children, flush = false }: { children: ReactNode; flush?: boolean }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.ring, { boxShadow: `0 0 0 1px ${colors["glass-edge"]}` }]}>
      <View style={[styles.card, { backgroundColor: colors.card, paddingVertical: flush ? 0 : 6 }]}>{children}</View>
    </View>
  )
}

export interface ReportRowProps {
  title: string
  subtitle: string
  phase: PhaseKey
  pillLabel: string
  /** overrides the phase colour, e.g. the red Failed pill */
  pillColor?: string
  /** the age under the pill; ignored while running */
  age: string
  running?: boolean
  /** draws the divider above the row */
  divider?: boolean
  onPress?: () => void
  onLongPress?: () => void
}

export function ReportRow({ title, subtitle, phase, pillLabel, pillColor, age, running, divider, onPress, onLongPress }: ReportRowProps) {
  const { colors } = useTheme()
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} delayLongPress={450} style={({ pressed }) => [styles.item, pressed && { opacity: 0.92 }]}>
      {divider ? <View style={[styles.divider, { backgroundColor: colors.line }]} /> : null}
      <View style={styles.main}>
        <Text style={[styles.itemT, { color: colors.foreground }]} numberOfLines={2}>
          {title}
        </Text>
        <Text style={[styles.itemS, { color: colors.muted }]} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <View style={styles.right}>
        <PhasePill phase={phase} label={pillLabel} color={pillColor} style={{ top: 1 }} />
        <Text style={[styles.itemB, { color: colors.muted }]}>{running ? "Running" : age}</Text>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  sh: { height: 36, paddingHorizontal: 20, paddingBottom: 12 },
  shRow: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" },
  shTitle: { fontFamily: font.semibold, fontSize: 20, lineHeight: 24, letterSpacing: -0.4 },
  shCount: { fontFamily: font.medium, fontSize: 15, lineHeight: 15, marginLeft: 2 },
  shMore: { position: "absolute", right: 10, top: -10, width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  ring: { marginHorizontal: 16, borderRadius: 24 },
  card: { borderRadius: 24, overflow: "hidden" },
  item: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 10, paddingLeft: 14, paddingRight: 18 },
  divider: { position: "absolute", top: 0, left: 18, right: 18, height: 1 },
  main: { flex: 1, minWidth: 0, top: -0.67 },
  itemT: { fontFamily: font.medium, fontSize: 17, lineHeight: 21.25, letterSpacing: -0.187 },
  itemS: { fontFamily: font.regular, fontSize: 13, lineHeight: 17.5, marginTop: 3 },
  right: { flexShrink: 0, alignItems: "flex-end", gap: 6 },
  itemB: { fontFamily: font.regular, fontSize: 13, lineHeight: 17.5, top: -0.33 },
})

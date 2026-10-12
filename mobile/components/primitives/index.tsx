/**
 * Shared primitive components for the mobile shell.
 *
 * Every screen imports from here. These match docs/site/screens/c.css and
 * docs/site/screens/c.js exactly (tokens from theme.ts): radius 24 cards,
 * 56pt min row height, 52pt primary button, 48pt icon buttons, phase pills
 * with a 6px dot and a 16% tint, the formSheet sheet (grabber, X, check),
 * the long-press menu, toast and the Geist Mono stack.
 *
 * The tab shell chrome (NativeTabs + Review FAB + bell/more pill) lives in
 * app/(tabs)/_layout.tsx and imports the primitives below.
 */
import React, { createContext, useContext, useEffect, useRef, useState } from "react"
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  Modal,
  ViewStyle,
  TextStyle,
  Animated,
  Easing,
} from "react-native"
import { LinearGradient } from "expo-linear-gradient"
import { useRouter } from "expo-router"
import { Icon } from "@/components/icons"
import type { IconName } from "@/components/icons"
import { SvgImage } from "@/components/SvgImage"
import { useTheme } from "@/theme"
import { GlassBlur } from "@/components/GlassBlur"
import { phaseLabel, usePhaseColor, phaseTint } from "@/lib/phases"
import type { PhaseKey } from "@/lib/phases"
import { font } from "@/lib/fonts"

const PRESS_OPACITY = 0.92

// ---------------------------------------------------------------
// PhasePill
// ---------------------------------------------------------------
export { usePhaseColor, phaseLabel, phaseTint }
export type { PhaseKey }

export interface PhasePillProps {
  phase: PhaseKey
  label?: string
  /** replaces the phase colour (the red Failed pill) */
  color?: string
  style?: ViewStyle
  labelStyle?: TextStyle
}

export function PhasePill({ phase, label, color: override, style, labelStyle }: PhasePillProps) {
  const phaseColor = usePhaseColor(phase)
  const color = override ?? phaseColor
  return (
    <View style={[styles.pill, { backgroundColor: phaseTint(color) }, style]}>
      <View style={[styles.pillDot, { backgroundColor: color }]} />
      <Text style={[styles.pillLabel, { color }, labelStyle]}>{label ?? phaseLabel(phase)}</Text>
    </View>
  )
}

// ---------------------------------------------------------------
// Card (radius 24)
// ---------------------------------------------------------------
export interface CardProps {
  children: React.ReactNode
  style?: ViewStyle
  rounded?: boolean
}

export function Card({ children, style, rounded = true }: CardProps) {
  const { colors, round } = useTheme()
  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderRadius: rounded ? round.cardRadius : undefined }, style]}>
      {children}
    </View>
  )
}

// ---------------------------------------------------------------
// Row (min height 56)
// ---------------------------------------------------------------
export interface RowProps {
  children: React.ReactNode
  style?: ViewStyle
  leading?: React.ReactNode
  trailing?: React.ReactNode
  onPress?: () => void
  testID?: string
}

export function Row({ children, style, leading, trailing, onPress, testID }: RowProps) {
  const { colors, spacing } = useTheme()
  const inner = (
    <>
      {leading ? <View style={styles.rowLeading}>{leading}</View> : null}
      <View style={[styles.rowMain, { flex: 1, minWidth: 0 }]}>{children}</View>
      {trailing ? <View style={styles.rowTrailing}>{trailing}</View> : null}
    </>
  )
  if (!onPress) {
    return (
      <View style={[styles.row, { minHeight: spacing.itemMinHeight, backgroundColor: colors.card }, style]} testID={testID}>
        {inner}
      </View>
    )
  }
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { minHeight: spacing.itemMinHeight, backgroundColor: colors.card }, pressed && { opacity: PRESS_OPACITY }, style]}
    >
      {inner}
    </Pressable>
  )
}

// ---------------------------------------------------------------
// KvRow (key/value, min height 56)
// ---------------------------------------------------------------
export interface KvRowProps {
  label: string
  value: React.ReactNode
  mono?: boolean
  style?: ViewStyle
}

export function KvRow({ label, value, mono = false, style }: KvRowProps) {
  const { colors, spacing } = useTheme()
  return (
    <View style={[styles.kv, { minHeight: spacing.itemMinHeight, backgroundColor: colors.card }, style]}>
      <Text style={[styles.kvLabel, { color: colors.muted }]}>{label}</Text>
      <Text style={[styles.kvValue, mono && styles.kvValueMono, { color: colors.foreground }]}>{value}</Text>
    </View>
  )
}

// ---------------------------------------------------------------
// GlassPill (the top bar bell + more container)
// ---------------------------------------------------------------
export interface GlassPillProps {
  children: React.ReactNode
  style?: ViewStyle
  round?: boolean
}

export function GlassPill({ children, style, round = false }: GlassPillProps) {
  const { colors, round: r } = useTheme()
  return (
    <View
      style={[
        styles.glassPill,
        {
          backgroundColor: colors.glass,
          borderColor: colors["glass-edge"],
          borderRadius: round ? 24 : r.tabPillRadius,
        },
        style,
      ]}
    >
      {children}
    </View>
  )
}

// ---------------------------------------------------------------
// PrimaryButton (52 high, radius 26)
// ---------------------------------------------------------------
export type ButtonVariant = "primary" | "secondary" | "destructive" | "ghost"

export interface PrimaryButtonProps {
  title: string
  onPress: () => void
  variant?: ButtonVariant
  disabled?: boolean
  style?: ViewStyle
  textStyle?: TextStyle
  icon?: IconName
}

export function PrimaryButton({ title, onPress, variant = "primary", disabled, style, textStyle, icon }: PrimaryButtonProps) {
  const { colors, round } = useTheme()
  const bg = variant === "primary" ? colors.brand : variant === "destructive" ? phaseTint("#EA3A3A") : variant === "ghost" ? "transparent" : colors.fill
  const fg = variant === "primary" ? "#ffffff" : variant === "destructive" ? "#EA3A3A" : colors.foreground
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        { minHeight: 52, borderRadius: round.buttonRadius, backgroundColor: bg, gap: 8 },
        pressed && !disabled && { opacity: PRESS_OPACITY },
        disabled && { opacity: 0.4 },
        style,
      ]}
    >
      {icon ? <Icon name={icon} size={20} stroke={fg} /> : null}
      <Text style={[styles.btnText, { color: fg, fontFamily: font.semibold, fontSize: 17, }, textStyle]}>{title}</Text>
    </Pressable>
  )
}

// ---------------------------------------------------------------
// IconButton (48x48) — re-exported for convenience
// ---------------------------------------------------------------
export { Icon }
export type { IconName }

// ---------------------------------------------------------------
// ScreenHeader (c.css .topbar + .h1 + .hmeta)
// ---------------------------------------------------------------
/** Distance from the top of the screen to the first line of content: c.css `--top` (54) + 62. */
export const TOP_INSET = 116

/** Fades the scroll content out under the status bar and the top buttons (c.css .fade-t, 124 high). */
export function TopFade() {
  const { colors } = useTheme()
  return (
    <LinearGradient
      pointerEvents="none"
      colors={[colors.background, colors.background, colors.background + "00"]}
      locations={[0, 0.66, 1]}
      style={styles.topFade}
    />
  )
}

/** The glass pill that holds the top buttons (c.css .topbar): 48 high, 1px edge, buttons 48 wide. */
export function TopBar({ side, children, round }: { side: "left" | "right"; children: React.ReactNode; round?: boolean }) {
  const { colors } = useTheme()
  return (
    <View
      style={[
        styles.topBar,
        side === "left" ? { left: 16 } : { right: 16 },
        round && { width: 48 },
        { backgroundColor: colors.glass, borderColor: colors["glass-edge"], overflow: "hidden" },
      ]}
    >
      <GlassBlur />
      {children}
    </View>
  )
}

/** One 48pt icon button inside a TopBar (c.css .ib). */
export function TopBarButton({ icon, onPress, label, size = 22, strokeWidth }: { icon: IconName; onPress?: () => void; label: string; size?: number; strokeWidth?: number }) {
  const { colors } = useTheme()
  return (
    <Pressable onPress={onPress} accessibilityLabel={label} style={({ pressed }) => [styles.topBarBtn, pressed && { opacity: 0.7 }]}>
      <Icon name={icon} size={size} strokeWidth={strokeWidth} stroke={colors.foreground} />
    </Pressable>
  )
}

export interface ScreenTitleProps {
  title: string
  /** meta line under the title (c.css .hmeta); a node is laid out as a wrapping row */
  meta?: React.ReactNode
  /** space under the meta line, 28 by default (m6 uses 16, m8 20) */
  metaBottom?: number
  /** leading space down to TOP_INSET; false when the screen already pads for the top buttons */
  inset?: boolean
}

/** The large title block, positioned as the mockups do: title at y 116, 28/700, then the meta line. Put it first inside the ScrollView. */
export function ScreenTitle({ title, meta, metaBottom = 28, inset = true }: ScreenTitleProps) {
  const { colors } = useTheme()
  return (
    <View style={inset ? { paddingTop: TOP_INSET } : undefined}>
      <Text style={[styles.h1, { color: colors.foreground }]}>{title}</Text>
      {meta != null && meta !== "" ? (
        typeof meta === "string" ? (
          <Text style={[styles.hmeta, { color: colors.muted, paddingBottom: metaBottom }]}>{meta}</Text>
        ) : (
          <View style={[styles.hmetaRow, { paddingBottom: metaBottom }]}>{meta}</View>
        )
      ) : (
        <View style={{ height: metaBottom }} />
      )}
    </View>
  )
}

export interface ScreenHeaderProps {
  /** When set, the title block is laid out in flow under the buttons (use it when the screen body is not a ScrollView of its own). */
  title?: string
  meta?: React.ReactNode
  /** show the round glass back button */
  back?: boolean
  /** "x" for screens opened as a modal flow (M20, M21), "back" otherwise */
  backIcon?: "back" | "x"
  onBack?: () => void
  backLabel?: string
  /** buttons for the right pill, e.g. <TopBarButton/> */
  right?: React.ReactNode
}

/**
 * Top chrome shared by detail screens: the round back button at the mockup's y (58), an optional
 * right pill, and the fade under them. Nothing is a native nav-bar title. The screen's own
 * ScrollView starts with <ScreenTitle>, so the title scrolls like the mockup's.
 */
export function ScreenHeader({ title, meta, back, backIcon = "back", onBack, backLabel, right }: ScreenHeaderProps) {
  const router = useRouter()
  return (
    <>
      {title ? <ScreenTitle title={title} meta={meta} /> : null}
      <View pointerEvents="box-none" style={styles.chrome}>
        <TopFade />
        {back ? (
          <TopBar side="left" round>
            <TopBarButton icon={backIcon} size={24} strokeWidth={2.2} label={backIcon === "x" ? "Close" : backLabel ? `Back to ${backLabel}` : "Back"} onPress={onBack ?? (() => router.back())} />
          </TopBar>
        ) : null}
        {right ? <TopBar side="right">{right}</TopBar> : null}
      </View>
    </>
  )
}

// ---------------------------------------------------------------
// SectionHeader (20/600, count, chevron + sort menu)
// ---------------------------------------------------------------
export interface SectionHeaderProps {
  title: string
  count?: number
  chevron?: boolean
  onSort?: () => void
}

export function SectionHeader({ title, count, chevron = true, onSort }: SectionHeaderProps) {
  const { colors } = useTheme()
  return (
    <View style={styles.sh}>
      <Text style={[styles.shText, { color: colors.foreground }]}>{title}</Text>
      {count !== undefined ? <Text style={[styles.shCount, { color: colors.muted }]}>{count}</Text> : null}
      {chevron ? <Icon name="chev" size={18} stroke={colors.muted} /> : null}
      {onSort ? (
        <Pressable
          onPress={onSort}
          style={({ pressed }) => [styles.shMore, pressed && { opacity: PRESS_OPACITY }]}
          aria-label="More options"
        >
          <Icon name="more" size={18} stroke={colors.faint} />
        </Pressable>
      ) : null}
    </View>
  )
}

// ---------------------------------------------------------------
// EmptyState (mascot + 24/700 heading)
// ---------------------------------------------------------------
export interface EmptyStateProps {
  /** mascot asset name, e.g. "greeting" or "scanning" */
  mascot?: "greeting" | "scanning" | "chilling" | "idle"
  heading: string
  body?: string
  action?: { title: string; onPress: () => void }
  inline?: boolean
}

export function EmptyState({ mascot = "greeting", heading, body, action, inline = false }: EmptyStateProps) {
  const { colors } = useTheme()
  return (
    <View style={[inline ? styles.emptyInline : styles.empty, { backgroundColor: colors.background }]}>
      <SvgImage name={`mascot/${mascot}`} width={inline ? 150 : 200} height={inline ? 150 : 200} />
      <Text style={[styles.emptyH, { color: colors.foreground }]}>{heading}</Text>
      {body ? <Text style={[styles.emptyP, { color: colors.muted }]}>{body}</Text> : null}
      {action ? <PrimaryButton title={action.title} onPress={action.onPress} /> : null}
    </View>
  )
}

// ---------------------------------------------------------------
// Sheet (formSheet: grabber, X, check)
// ---------------------------------------------------------------
export interface SheetProps {
  children: React.ReactNode
  visible: boolean
  onClose: () => void
  onConfirm?: () => void
  title?: string
  subtitle?: string
  confirmDisabled?: boolean
}

export function Sheet({ children, visible, onClose, onConfirm, title, subtitle, confirmDisabled }: SheetProps) {
  const { colors } = useTheme()
  const [show, setShow] = useState(visible)
  const anim = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (visible) {
      setShow(true)
      Animated.spring(anim, { toValue: 1, useNativeDriver: true, bounciness: 8, speed: 12 } as any).start()
    } else {
      // An interrupted close (visible turned true again) must not hide the sheet.
      Animated.timing(anim, { toValue: 0, duration: 200, useNativeDriver: true }).start(({ finished }) => finished && setShow(false))
    }
  }, [visible, anim])

  if (!show) return null

  return (
    <Modal transparent visible onRequestClose={onClose} animationType="none">
      <View style={styles.sheetScrims}>
        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.sheet,
              borderColor: colors["glass-edge"],
              transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [400, 0] }) }],
              opacity: anim,
            },
          ]}
        >
          <View style={styles.sheetGrabber}><View style={styles.sheetGrabberBar} /></View>
          <Pressable onPress={onClose} style={[styles.sheetSbtn, styles.sheetSbtnX]} accessibilityLabel="Cancel">
            <Icon name="x" size={24} stroke={colors.foreground} />
          </Pressable>
          {onConfirm ? (
            <Pressable onPress={onConfirm} disabled={confirmDisabled} style={[styles.sheetSbtn, styles.sheetSbtnOk, confirmDisabled && { opacity: 0.4 }]} accessibilityLabel="Confirm">
              <Icon name="check" size={26} strokeWidth={2.4} stroke="#ffffff" />
            </Pressable>
          ) : null}
          {title ? <Text style={[styles.sheetTitle, { color: colors.muted }]}>{title}</Text> : null}
          {subtitle ? <Text style={[styles.sheetSubtitle, { color: colors.muted }]}>{subtitle}</Text> : null}
          <View style={styles.sheetContent}>{children}</View>
        </Animated.View>
      </View>
    </Modal>
  )
}

// ---------------------------------------------------------------
// LongPressMenu (450ms; Open case file, Copy report id, Share, Assign to me)
// ---------------------------------------------------------------
export interface LongPressMenuProps {
  /** the report id, shown as the copy target */
  reportId?: string
  onOpenCaseFile?: () => void
  onCopyId?: () => void
  onShare?: () => void
  onAssignToMe?: () => void
  visible: boolean
  onClose: () => void
}

export function LongPressMenu({ reportId, onOpenCaseFile, onCopyId, onShare, onAssignToMe, visible, onClose }: LongPressMenuProps) {
  const { colors } = useTheme()
  const [show, setShow] = useState(visible)
  useEffect(() => {
    setShow(visible)
  }, [visible])
  void reportId
  if (!show) return null
  const items: { label: string; icon: IconName; onPress: () => void }[] = [
    { label: "Open case file", icon: "open", onPress: onOpenCaseFile ?? onClose },
    { label: "Copy report id", icon: "copy", onPress: onCopyId ?? onClose },
    { label: "Share", icon: "share", onPress: onShare ?? onClose },
  ]
  if (onAssignToMe) {
    items.push({ label: "Assign to me", icon: "userplus", onPress: onAssignToMe })
  }
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose} hardwareAccelerated>
      <View style={[styles.sheetScrims, { backgroundColor: colors.background }]} onStartShouldSetResponder={() => true} onResponderRelease={onClose}>
        <View style={[styles.longPressMenu, { backgroundColor: colors["sheet-card"] }]} onStartShouldSetResponder={() => true} onResponderRelease={(e) => e.stopPropagation()}>
          {items.map((it) => (
            <Pressable key={it.label} onPress={it.onPress} style={({ pressed }) => [{ opacity: pressed ? PRESS_OPACITY : 1 }, styles.longPressItem]} accessibilityLabel={it.label}>
              <Icon name={it.icon} size={20} stroke={colors.muted} />
              <Text style={[styles.longPressLabel, { color: colors.foreground }]}>{it.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  )
}

// ---------------------------------------------------------------
// Mono (Geist Mono)
// ---------------------------------------------------------------
export interface MonoProps {
  children: React.ReactNode
  style?: TextStyle
}

export function Mono({ children, style }: MonoProps) {
  const { typography } = useTheme()
  return <Text style={[styles.mono, { fontFamily: typography.fontMono }, style]}>{children}</Text>
}

// ---------------------------------------------------------------
// Toast — context + provider so any screen can show one
// ---------------------------------------------------------------
interface ToastContextValue {
  show: (message: string, durationMs?: number) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error("useToast must be used within a ToastProvider")
  return ctx
}

interface ToastItem {
  id: number
  message: string
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { colors, typography } = useTheme()
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const show = (message: string, durationMs = 2200) => {
    const id = Date.now() + Math.random()
    setToasts((prev) => [...prev, { id, message }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), durationMs)
  }
  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {toasts.map((t) => (
        <View key={t.id} style={[styles.toast, { backgroundColor: colors.sheet, borderColor: colors["glass-edge"] }]}>
          <Text style={[styles.toastText, { color: colors.foreground, fontFamily: typography.fontMono }]}>{t.message}</Text>
        </View>
      ))}
    </ToastContext.Provider>
  )
}

const styles = StyleSheet.create({
  pill: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 11, paddingVertical: 6, borderRadius: 99 },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillLabel: { fontFamily: font.semibold, fontSize: 13, lineHeight: 13 },
  card: { borderRadius: 24, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth },
  rowLeading: { paddingLeft: 0, paddingRight: 12 },
  rowMain: { flex: 1, minWidth: 0 },
  rowTrailing: { paddingLeft: 12, paddingRight: 0 },
  kv: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth },
  kvLabel: { fontFamily: font.regular, fontSize: 15, lineHeight: 20 },
  kvValue: { fontFamily: font.regular, fontSize: 15, lineHeight: 20, textAlign: "right", flexShrink: 1 },
  kvValueMono: { fontFamily: font.mono, fontSize: 12 },
  glassPill: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 8, borderWidth: StyleSheet.hairlineWidth },
  btn: { alignItems: "center", justifyContent: "center", flexDirection: "row", paddingHorizontal: 22 },
  btnText: { fontFamily: font.semibold, fontSize: 17, },
  chrome: { position: "absolute", top: 0, left: 0, right: 0, height: 124, zIndex: 30 },
  topFade: { position: "absolute", top: 0, left: 0, right: 0, height: 124 },
  topBar: { position: "absolute", top: 58, height: 48, borderRadius: 24, borderWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", zIndex: 30 },
  topBarBtn: { width: 48, height: 46, alignItems: "center", justifyContent: "center", borderRadius: 24 },
  h1: { fontFamily: font.bold, fontSize: 28, lineHeight: 32.2, letterSpacing: -0.84, paddingTop: 8, paddingHorizontal: 20 },
  hmeta: { fontFamily: font.regular, fontSize: 15, lineHeight: 20.25, paddingTop: 14, paddingHorizontal: 20 },
  hmetaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10, paddingTop: 14, paddingHorizontal: 20 },
  sh: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 20, paddingVertical: 12 },
  shText: { fontFamily: font.semibold, fontSize: 20, lineHeight: 24 },
  shCount: { marginLeft: 4, fontFamily: font.semibold, fontSize: 20, lineHeight: 24 },
  shMore: { marginLeft: "auto", paddingLeft: 8, paddingVertical: 4 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 18, paddingBottom: 40 },
  emptyInline: { alignItems: "center", gap: 12, paddingVertical: 24 },
  emptyH: { fontFamily: font.bold, fontSize: 24, letterSpacing: -0.5, lineHeight: 29, textAlign: "center" },
  emptyP: { fontFamily: font.regular, fontSize: 15, lineHeight: 23, textAlign: "center", maxWidth: 300 },
  sheetScrims: { flex: 1, justifyContent: "flex-end", paddingBottom: 30, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 34, gap: 12, borderWidth: StyleSheet.hairlineWidth },
  sheetGrabber: { alignSelf: "center", paddingVertical: 6 },
  sheetGrabberBar: { width: 40, height: 5, borderRadius: 99, backgroundColor: "rgba(255,255,255,0.3)" },
  sheetSbtn: { position: "absolute", width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", zIndex: 1 },
  sheetSbtnX: { top: 14, left: 16 },
  sheetSbtnOk: { top: 14, right: 16, backgroundColor: "#6774F0", borderColor: "#6774F0" },
  sheetTitle: { fontFamily: font.regular, fontSize: 13, lineHeight: 20, textAlign: "center" },
  sheetSubtitle: { fontFamily: font.regular, fontSize: 13, lineHeight: 20, textAlign: "center" },
  sheetContent: { maxHeight: 360, paddingVertical: 8 },
  longPressMenu: { marginHorizontal: 16, marginBottom: 40, borderRadius: 20, overflow: "hidden", gap: 2 },
  longPressItem: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  longPressLabel: { fontFamily: font.semibold, fontSize: 17, lineHeight: 22 },
  mono: { fontFamily: font.regular, fontSize: 12 },
  toast: { position: "absolute", bottom: 80, left: "50%", transform: [{ translateX: -100 }], paddingHorizontal: 18, paddingVertical: 10, borderRadius: 99, minHeight: 40, alignItems: "center", justifyContent: "center", maxWidth: 280, borderWidth: StyleSheet.hairlineWidth },
  toastText: { fontFamily: font.regular, fontSize: 13, lineHeight: 18, textAlign: "center" },
})

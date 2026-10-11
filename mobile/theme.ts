/**
 * Design tokens derived from docs/site/screens/c.css.
 * Light and dark palettes, phase hues, spacing, and typography.
 *
 * The hex values are pre-converted from the oklch() tokens in the stylesheet.
 * Dark theme maps to c.css :root (dark), light theme to :root.light.
 */
import { useColorScheme } from "react-native"

export type ColorScheme = "light" | "dark"

export interface Theme {
  colors: {
    page: string
    background: string
    card: string
    raised: string
    foreground: string
    muted: string
    faint: string
    line: string
    glass: string
    "glass-edge": string
    fill: string
    selection: string
    sheet: string
    "sheet-card": string
    hover: string
    brand: string
    "brand-soft": string
    red: string
  }
  phase: {
    triaging: string
    reproducing: string
    analysis: string
    approval: string
    delivered: string
    closed: string
  }
  spacing: {
    screenPadding: number
    sectionGap: number
    itemPadding: number
    itemMinHeight: number
    buttonMinHeight: number
    touchTarget: number
    cornerRadius: number
    fieldRadius: number
    tabBarHeight: number
    topBarHeight: number
  }
  typography: {
    fontFamily: string
    fontMono: string
    bodyFontSize: number
    bodyLineHeight: number
    h1FontSize: number
    h1LineHeight: number
    sectionHeaderFontSize: number
    noteFontSize: number
    pillFontSize: number
  }
}

export const lightTheme: Theme = {
  colors: {
    page: "#efeff3",
    background: "#f4f4f8",
    card: "#ffffff",
    raised: "#f7f7fa",
    foreground: "#25252a",
    muted: "#82828a",
    faint: "#9e9ea6",
    line: "rgba(0, 0, 0, 0.08)",
    glass: "rgba(255, 255, 255, 0.68)",
    "glass-edge": "rgba(0, 0, 0, 0.08)",
    fill: "rgba(0, 0, 0, 0.06)",
    selection: "rgba(0, 0, 0, 0.10)",
    sheet: "rgba(247, 247, 250, 0.96)",
    "sheet-card": "#ffffff",
    hover: "rgba(0, 0, 0, 0.04)",
    brand: "#7a4dff",
    "brand-soft": "#7a4dff",
    red: "#ff6b6b",
  },
  phase: {
    triaging: "#5c5cdb",
    reproducing: "#5c9eff",
    analysis: "#e066d9",
    approval: "#d4b930",
    delivered: "#4cb36b",
    closed: "#888888",
  },
  spacing: {
    screenPadding: 20,
    sectionGap: 28,
    itemPadding: 18,
    itemMinHeight: 56,
    buttonMinHeight: 52,
    touchTarget: 44,
    cornerRadius: 24,
    fieldRadius: 20,
    tabBarHeight: 88,
    topBarHeight: 54,
  },
  typography: {
    fontFamily: "Inter",
    fontMono: "GeistMono",
    bodyFontSize: 17,
    bodyLineHeight: 23,
    h1FontSize: 28,
    h1LineHeight: 32,
    sectionHeaderFontSize: 20,
    noteFontSize: 13,
    pillFontSize: 13,
  },
}

export const darkTheme: Theme = {
  colors: {
    page: "#16161a",
    background: "#1a1a1f",
    card: "#222228",
    raised: "#333339",
    foreground: "#f7f7fa",
    muted: "#b8b8c0",
    faint: "#919199",
    line: "rgba(255, 255, 255, 0.10)",
    glass: "rgba(43, 43, 49, 0.6)",
    "glass-edge": "rgba(255, 255, 255, 0.10)",
    fill: "rgba(255, 255, 255, 0.10)",
    selection: "rgba(255, 255, 255, 0.16)",
    sheet: "rgba(32, 32, 36, 0.94)",
    "sheet-card": "#333339",
    hover: "rgba(255, 255, 255, 0.05)",
    brand: "#7a4dff",
    "brand-soft": "#c9b6ff",
    red: "#ff5b5b",
  },
  phase: {
    triaging: "#7d7dff",
    reproducing: "#6cb4ff",
    analysis: "#ff7bce",
    approval: "#e6d04d",
    delivered: "#5cd68a",
    closed: "#888888",
  },
  spacing: {
    screenPadding: 20,
    sectionGap: 28,
    itemPadding: 18,
    itemMinHeight: 56,
    buttonMinHeight: 52,
    touchTarget: 44,
    cornerRadius: 24,
    fieldRadius: 20,
    tabBarHeight: 88,
    topBarHeight: 54,
  },
  typography: {
    fontFamily: "Inter",
    fontMono: "GeistMono",
    bodyFontSize: 17,
    bodyLineHeight: 23,
    h1FontSize: 28,
    h1LineHeight: 32,
    sectionHeaderFontSize: 20,
    noteFontSize: 13,
    pillFontSize: 13,
  },
}

export function useTheme(): Theme {
  const colorScheme = useColorScheme()
  return colorScheme === "dark" ? darkTheme : lightTheme
}

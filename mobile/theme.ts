/**
 * Design tokens derived from docs/site/screens/c.css.
 * Hex values are converted from the oklch() tokens in the stylesheet
 * using the CSS Color 4 reference algorithm.
 * The design is dark by default (c.css uses color-scheme:dark as the root).
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
    sectionHeaderLineHeight: number
    noteFontSize: number
    pillFontSize: number
    h2FontSize: number
  }
  round: {
    screenRadius: number
    cardRadius: number
    buttonRadius: number
    fieldRadius: number
    tabPillRadius: number
  }
}

// Convert oklch() to hex using the CSS Color 4 reference algorithm.
// For C=0 (achromatic) the raw sRGB channels differ by less than 2 units,
// so we average them to produce a clean gray that matches the visual intent.
function srgbFromLinear(v: number): number {
  if (v <= 0) return 0
  if (v >= 1) return 1
  return v <= 0.0031308 ? 12.92 * v : Math.pow(v, 1 / 2.4) * 1.055 - 0.055
}

export function oklchToHex(l: number, c: number, h: number): string {
  const rad = (h * Math.PI) / 180
  const a = c * Math.cos(rad)
  const b = c * Math.sin(rad)
  let l_val = l + 0.3963377774 * a + 0.2158037573 * b
  let m_val = l - 0.1055613458 * a - 0.0638541728 * b
  let s_val = l - 0.0894841775 * a - 1.291485548 * b
  l_val = Math.pow(l_val, 3)
  m_val = Math.pow(m_val, 3)
  s_val = Math.pow(s_val, 3)
  const r_lin = 4.0767416621 * l_val - 3.3077115913 * m_val + 0.2309699292 * s_val
  const g_lin = -1.2684380046 * l_val + 2.6097574011 * m_val - 0.3413193965 * s_val
  const b_lin = -0.0041960863 * l_val - 0.7034186147 * m_val + 1.707614701 * s_val
  const r = Math.max(0, Math.min(1, srgbFromLinear(r_lin)))
  const g = Math.max(0, Math.min(1, srgbFromLinear(g_lin)))
  const b2 = Math.max(0, Math.min(1, srgbFromLinear(b_lin)))
  if (c === 0) {
    // Achromatic: average channels for a clean gray.
    const avg = Math.round(((r + g + b2) / 3) * 255)
    const h2 = avg.toString(16).padStart(2, "0").toUpperCase()
    return "#" + h2 + h2 + h2
  }
  return (
    "#" +
    [r, g, b2]
      .map((v) => Math.round(v * 255).toString(16).padStart(2, "0").toUpperCase())
      .join("")
  )
}

export const darkTheme: Theme = {
  colors: {
    page: oklchToHex(0.11, 0, 0),
    background: oklchToHex(0.145, 0, 0),
    card: oklchToHex(0.178, 0, 0),
    raised: oklchToHex(0.269, 0, 0),
    foreground: oklchToHex(0.985, 0, 0),
    muted: oklchToHex(0.72, 0, 0),
    faint: oklchToHex(0.56, 0, 0),
    line: "rgba(255, 255, 255, 0.08)",
    glass: "rgba(38, 38, 38, 0.6)",
    "glass-edge": "rgba(255, 255, 255, 0.10)",
    fill: "rgba(255, 255, 255, 0.10)",
    selection: "rgba(255, 255, 255, 0.16)",
    sheet: "rgba(23, 23, 23, 0.94)",
    "sheet-card": oklchToHex(0.26, 0, 0),
    hover: "rgba(255, 255, 255, 0.05)",
    brand: oklchToHex(0.585, 0.233, 277.117),
    "brand-soft": oklchToHex(0.785, 0.115, 274.713),
    red: oklchToHex(0.704, 0.191, 22.216),
  },
  phase: {
    triaging: oklchToHex(0.7, 0.15, 250),
    reproducing: oklchToHex(0.75, 0.13, 195),
    analysis: oklchToHex(0.72, 0.18, 330),
    approval: oklchToHex(0.8, 0.15, 75),
    delivered: oklchToHex(0.72, 0.16, 150),
    closed: oklchToHex(0.55, 0, 0),
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
    fontFamily: "Inter_400Regular",
    fontMono: "GeistMono_400Regular",
    bodyFontSize: 17,
    bodyLineHeight: 23,
    h1FontSize: 28,
    h1LineHeight: 32,
    sectionHeaderFontSize: 20,
    sectionHeaderLineHeight: 24,
    noteFontSize: 13,
    pillFontSize: 13,
    h2FontSize: 24,
  },
  round: {
    screenRadius: 55,
    cardRadius: 24,
    buttonRadius: 26,
    fieldRadius: 20,
    tabPillRadius: 32,
  },
}

export const lightTheme: Theme = {
  colors: {
    page: oklchToHex(0.94, 0, 0),
    background: oklchToHex(0.965, 0, 0),
    card: "#ffffff",
    raised: oklchToHex(0.94, 0, 0),
    foreground: oklchToHex(0.145, 0, 0),
    muted: oklchToHex(0.5, 0, 0),
    faint: oklchToHex(0.62, 0, 0),
    line: "rgba(0, 0, 0, 0.08)",
    glass: "rgba(245, 245, 245, 0.68)",
    "glass-edge": "rgba(0, 0, 0, 0.08)",
    fill: "rgba(0, 0, 0, 0.06)",
    selection: "rgba(0, 0, 0, 0.10)",
    sheet: "rgba(245, 245, 245, 0.96)",
    "sheet-card": "#ffffff",
    hover: "rgba(0, 0, 0, 0.04)",
    brand: oklchToHex(0.585, 0.233, 277.117),
    "brand-soft": oklchToHex(0.457, 0.24, 277.023),
    red: oklchToHex(0.577, 0.245, 27.325),
  },
  phase: {
    triaging: oklchToHex(0.52, 0.17, 250),
    reproducing: oklchToHex(0.55, 0.13, 195),
    analysis: oklchToHex(0.53, 0.2, 330),
    approval: oklchToHex(0.62, 0.15, 75),
    delivered: oklchToHex(0.52, 0.15, 150),
    closed: oklchToHex(0.55, 0, 0),
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
    fontFamily: "Inter_400Regular",
    fontMono: "GeistMono_400Regular",
    bodyFontSize: 17,
    bodyLineHeight: 23,
    h1FontSize: 28,
    h1LineHeight: 32,
    sectionHeaderFontSize: 20,
    sectionHeaderLineHeight: 24,
    noteFontSize: 13,
    pillFontSize: 13,
    h2FontSize: 24,
  },
  round: {
    screenRadius: 55,
    cardRadius: 24,
    buttonRadius: 26,
    fieldRadius: 20,
    tabPillRadius: 32,
  },
}

export function useTheme(): Theme {
  const colorScheme = useColorScheme()
  return colorScheme === "dark" ? darkTheme : lightTheme
}

/**
 * Loaded font family names (hooks/useFonts.ts). React Native picks a face by family name, so every
 * weight is its own family; fontWeight alone would fall back to the system font.
 */
export const font = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
  mono: "GeistMono_400Regular",
  monoMedium: "GeistMono_500Medium",
} as const

/** The Inter family for a CSS weight. */
export function interFor(weight: string | number | undefined): string {
  switch (String(weight ?? "400")) {
    case "500": return font.medium
    case "600": return font.semibold
    case "700":
    case "bold": return font.bold
    default: return font.regular
  }
}

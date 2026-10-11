import { Appearance } from "react-native"
import AsyncStorage from "@react-native-async-storage/async-storage"

export type ThemeMode = "system" | "light" | "dark"

const KEY = "bd.themeMode"

/**
 * Overrides the colour scheme app-wide. useColorScheme(), which useTheme() reads, follows this
 * override, so every screen switches without a theme context of its own.
 */
export function applyThemeMode(mode: ThemeMode): void {
  Appearance.setColorScheme(mode === "system" ? "unspecified" : mode)
}

export async function saveThemeMode(mode: ThemeMode): Promise<void> {
  applyThemeMode(mode)
  await AsyncStorage.setItem(KEY, mode).catch(() => {})
}

/** Reads the saved choice (system when none or unreadable) and applies it. */
export async function restoreThemeMode(): Promise<ThemeMode> {
  const raw = await AsyncStorage.getItem(KEY).catch(() => null)
  const mode: ThemeMode = raw === "light" || raw === "dark" ? raw : "system"
  applyThemeMode(mode)
  return mode
}

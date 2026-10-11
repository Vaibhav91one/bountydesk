/**
 * Loads Inter and Geist Mono, the font families defined in c.css:
 * --font-sans: Inter, 400/500/600/700 -- --font-mono: "Geist Mono", 400/500
 *
 * Inter is a Google Font served by @expo-google-fonts/inter.
 * Geist Mono is served by @expo-google-fonts/geist-mono.
 */
import { useEffect, useState } from "react"
import { useFonts as useExpoFonts } from "expo-font"
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter"
import {
  GeistMono_400Regular,
  GeistMono_500Medium,
} from "@expo-google-fonts/geist-mono"

export function useFonts() {
  const [loaded] = useExpoFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    GeistMono_400Regular,
    GeistMono_500Medium,
  })
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (loaded) setReady(true)
  }, [loaded])

  return ready
}

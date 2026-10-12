/** M1 Splash. Brand surface with greeting mascot and logo lockup. Advances to sign-in.
 * Matches docs/site/screens/m1.html exactly.
 *
 * Layout: centered column with greeting mascot (animated float), logo lockup (inverted on light),
 * and tagline. Advances to /auth/sign-in after 1600ms.
 */
import { useEffect } from "react"
import { View, Text, StyleSheet, Animated, Easing } from "react-native"
import { useRouter } from "expo-router"
import { useAuth } from "@/lib/auth-hooks"

import { SvgImage } from "@/components/SvgImage"
import { darkTheme } from "@/theme"
import { font } from "@/lib/fonts"

export default function SplashScreen() {
  const router = useRouter()
  const { isLoaded } = useAuth()
  const t = darkTheme
  const floatAnim = new Animated.Value(0)

  useEffect(() => {
    // Floating animation: translateY -8px over 3.2s, ease-in-out, infinite.
    // In c.css: @keyframes m1f { 50% { transform: translate-y(-8px) } }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim, {
          toValue: -8,
          duration: 1600,
          easing: Easing.bezier(0.95, 0, 0.39, 1),
          useNativeDriver: true,
        }),
        Animated.timing(floatAnim, {
          toValue: 0,
          duration: 1600,
          easing: Easing.bezier(0.95, 0, 0.39, 1),
          useNativeDriver: true,
        }),
      ]),
    )
    anim.start()
    return () => anim.stop()
  }, [floatAnim])

  useEffect(() => {
    if (!isLoaded) return
    // data-auto-ms defaults to 1600ms in c.js
    const timeout = setTimeout(() => {
      router.replace("/auth/sign-in")
    }, 1600)
    return () => clearTimeout(timeout)
  }, [isLoaded, router])

  return (
    <View style={[styles.container, { backgroundColor: t.colors.background }]}>
      <View style={styles.wrap}>
        <Animated.View style={{ transform: [{ translateY: floatAnim }] }}>
          <SvgImage name="mascot/greeting" width={220} height={220} />
        </Animated.View>
        {/* m1-lockup: invert on light theme (filter:invert(1) hue-rotate(180deg)) */}
        <SvgImage name="logo-lockup" width={230} height={59} />
        <Text style={[styles.tagline, { color: t.colors.muted }]}>
          Triage you can trust, one approval at a time.
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  wrap: {
    flexDirection: "column",
    alignItems: "center",
    gap: 28, // matches gap:28px in .m1-wrap
    paddingBottom: 40,
  },
  tagline: {
    fontFamily: font.regular, fontSize: 15, // .9375rem in c.css
    letterSpacing: 0,
  },
})

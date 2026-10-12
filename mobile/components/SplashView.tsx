/** M1 splash surface: floating greeting mascot, logo lockup and tagline.
 * Shown at launch while the session resolves, and by /auth/splash. Matches docs/site/screens/m1.html.
 */
import { useEffect, useRef } from "react"
import { View, Text, StyleSheet, Animated, Easing } from "react-native"

import { SvgImage } from "@/components/SvgImage"
import { AnimatedMascot } from "@/components/AnimatedMascot"
import { darkTheme } from "@/theme"
import { font } from "@/lib/fonts"

export function SplashView() {
  const t = darkTheme
  const floatAnim = useRef(new Animated.Value(0)).current

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

  return (
    <View style={[styles.container, { backgroundColor: t.colors.background }]}>
      <View style={styles.wrap}>
        <Animated.View style={{ transform: [{ translateY: floatAnim }] }}>
          <AnimatedMascot name="greeting" size={220} />
        </Animated.View>
        <SvgImage name="logo-lockup" width={230} height={34.3} />
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

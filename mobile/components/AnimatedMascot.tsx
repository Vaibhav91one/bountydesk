/**
 * The 14 brand mascots, animated like the design. The SVGs animate with CSS @keyframes, which
 * react-native-svg cannot run, so the original markup goes into a WebView (no JS needed). The
 * static PNG shows until the WebView has loaded, and alone when Reduce Motion is on. `float`
 * is c.css .float: a slow bob and tilt on the whole image.
 */
import { useEffect, useState } from "react"
import { AccessibilityInfo, Image, StyleSheet, View, type ViewStyle } from "react-native"
import { WebView } from "react-native-webview"
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated"

import { MASCOT_SVG, type MascotName } from "@/assets/brand/mascot"

export type { MascotName }

const PNG: Record<MascotName, number> = {
  "awaiting-approval": require("../assets/brand/mascot-png/awaiting-approval.png"),
  "canary-found": require("../assets/brand/mascot-png/canary-found.png"),
  "celebrating": require("../assets/brand/mascot-png/celebrating.png"),
  "chilling": require("../assets/brand/mascot-png/chilling.png"),
  "cowboy": require("../assets/brand/mascot-png/cowboy.png"),
  "delivered": require("../assets/brand/mascot-png/delivered.png"),
  "denied": require("../assets/brand/mascot-png/denied.png"),
  "greeting": require("../assets/brand/mascot-png/greeting.png"),
  "idle": require("../assets/brand/mascot-png/idle.png"),
  "infra-hiccup": require("../assets/brand/mascot-png/infra-hiccup.png"),
  "ingest": require("../assets/brand/mascot-png/ingest.png"),
  "out-of-scope": require("../assets/brand/mascot-png/out-of-scope.png"),
  "reproducing": require("../assets/brand/mascot-png/reproducing.png"),
  "scanning": require("../assets/brand/mascot-png/scanning.png"),
}

const html = (svg: string) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}svg{display:block;width:100%;height:100%}</style></head><body>${svg}</body></html>`

// c.css: --float-y -6px, --float-tilt -2deg, 4s ease-in-out infinite (0% and 100% rest, 50% peak).
function Float({ children }: { children: React.ReactNode }) {
  const p = useSharedValue(0)
  useEffect(() => {
    const t = { duration: 2000, easing: Easing.inOut(Easing.ease) }
    p.value = withRepeat(withSequence(withTiming(1, t), withTiming(0, t)), -1)
  }, [p])
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: -6 * p.value }, { rotate: `${-2 * p.value}deg` }] }))
  return <Animated.View style={style}>{children}</Animated.View>
}

export interface AnimatedMascotProps {
  name: MascotName
  size: number
  float?: boolean
  style?: ViewStyle
}

export function AnimatedMascot({ name, size, float = false, style }: AnimatedMascotProps) {
  const [reduce, setReduce] = useState<boolean | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let live = true
    AccessibilityInfo.isReduceMotionEnabled().then((v) => live && setReduce(v))
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce)
    return () => {
      live = false
      sub?.remove?.()
    }
  }, [])

  const animate = reduce === false
  const shown = animate && loaded
  const body = (
    <View pointerEvents="none" style={[{ width: size, height: size }, style]} accessible={false} importantForAccessibility="no-hide-descendants">
      {shown ? null : <Image testID="mascot-static" source={PNG[name]} style={{ width: size, height: size }} />}
      {animate ? (
        <WebView
          style={[StyleSheet.absoluteFill, { backgroundColor: "transparent", opacity: loaded ? 1 : 0 }]}
          source={{ html: html(MASCOT_SVG[name]) }}
          originWhitelist={["*"]}
          javaScriptEnabled={false}
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          scalesPageToFit={false}
          opaque={false}
          pointerEvents="none"
          onLoadEnd={() => setLoaded(true)}
        />
      ) : null}
    </View>
  )
  return float && reduce === false ? <Float>{body}</Float> : body
}

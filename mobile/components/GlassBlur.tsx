import { StyleSheet } from "react-native"
import { BlurView } from "expo-blur"

/**
 * Backdrop blur for a glass surface (c.css .glass: blur(24px) saturate(180%)). Drop it as the first
 * child of a View that has the translucent glass background, a radius and overflow hidden.
 */
export function GlassBlur({ intensity = 45 }: { intensity?: number }) {
  return <BlurView tint="dark" intensity={intensity} pointerEvents="none" style={StyleSheet.absoluteFill} />
}

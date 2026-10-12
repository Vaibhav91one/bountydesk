/**
 * Renders SVG assets from mobile/assets/brand/ using react-native-svg.
 *
 * SVG files are imported as React components via react-native-svg-transformer
 * (configured in metro.config.js), so the real docs/site/assets source files
 * render directly through react-native-svg with no manual path copying.
 *
 * The `name` prop selects a known asset: "logo-mark",
 * "logo-lockup", "logo-tick", "logo-small" and "trix".
 */
import React from "react"
import { ViewStyle } from "react-native"

// React component SVGs, resolved by the bundler via react-native-svg-transformer.
// Each file becomes a default-exported React component.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const LogoMark = require("../assets/brand/logo/logo-mark.svg").default as React.ComponentType<any>
// eslint-disable-next-line @typescript-eslint/no-var-requires
const LogoLockup = require("../assets/brand/logo/logo-lockup.svg").default as React.ComponentType<any>
// eslint-disable-next-line @typescript-eslint/no-var-requires
const LogoTick = require("../assets/brand/logo/logo-tick.svg").default as React.ComponentType<any>
// eslint-disable-next-line @typescript-eslint/no-var-requires
const LogoSmall = require("../assets/brand/logo-small.svg").default as React.ComponentType<any>
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Trix = require("../assets/brand/trix.svg").default as React.ComponentType<any>
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AppIcon = require("../assets/brand/app-icon.svg").default as React.ComponentType<any>

// Static component map for the logos and icon.
const ASSETS: Record<string, React.ComponentType<any>> = {
  "logo-mark": LogoMark,
  "logo-lockup": LogoLockup,
  "logo-tick": LogoTick,
  "logo-small": LogoSmall,
  trix: Trix,
  "app-icon": AppIcon,
}

export type SvgName = keyof typeof ASSETS

export interface SvgImageProps {
  /** Asset name, e.g. "logo-lockup", "trix". */
  name: SvgName
  width: number
  height: number
  style?: ViewStyle
  /** accessibilityLabel for screen readers. */
  accessibilityLabel?: string
  /** Aligns the asset's intrinsic aspect ratio within the box. Defaults to meet. */
  preserveAspectRatio?: string
}

/**
 * Renders a named SVG asset. Logo and mascot files carry their own fills,
 * so pass a `style` with `tintColor` to re-color when needed.
 */
export function SvgImage({ name, width, height, style, accessibilityLabel, preserveAspectRatio = "xMidYMid meet" }: SvgImageProps) {
  const Asset = ASSETS[name]
  if (!Asset) {
    // Surface a missing asset loudly in dev instead of silently rendering nothing
    // (this is exactly how the empty logo bug hid for a sprint).
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn(`SvgImage: no asset registered for "${name}"`)
    }
    return null
  }
  return (
    <Asset
      width={width}
      height={height}
      style={style}
      accessibilityLabel={accessibilityLabel}
      preserveAspectRatio={preserveAspectRatio}
    />
  )
}

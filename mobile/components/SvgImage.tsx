/**
 * Renders SVG assets from mobile/assets/brand/ using react-native-svg.
 *
 * SVG files are imported as React components via react-native-svg-transformer
 * (configured in metro.config.js), so the real docs/site/assets source files
 * render directly through react-native-svg with no manual path copying.
 *
 * The `name` prop selects a known asset. For mascots use "mascot/<name>"
 * (mascot/greeting, mascot/out-of-scope, etc.), and for logos "logo-mark",
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

// Mascot assets share a directory, so they are lazy require'd by name.
const MASCOT_MODULES: Record<string, React.ComponentType<any>> = {
  "mascot/awaiting-approval": require("../assets/brand/mascot/awaiting-approval.svg").default,
  "mascot/canary-found": require("../assets/brand/mascot/canary-found.svg").default,
  "mascot/celebrating": require("../assets/brand/mascot/celebrating.svg").default,
  "mascot/chilling": require("../assets/brand/mascot/chilling.svg").default,
  "mascot/cowboy": require("../assets/brand/mascot/cowboy.svg").default,
  "mascot/delivered": require("../assets/brand/mascot/delivered.svg").default,
  "mascot/denied": require("../assets/brand/mascot/denied.svg").default,
  "mascot/greeting": require("../assets/brand/mascot/greeting.svg").default,
  "mascot/idle": require("../assets/brand/mascot/idle.svg").default,
  "mascot/infra-hiccup": require("../assets/brand/mascot/infra-hiccup.svg").default,
  "mascot/ingest": require("../assets/brand/mascot/ingest.svg").default,
  "mascot/out-of-scope": require("../assets/brand/mascot/out-of-scope.svg").default,
  "mascot/reproducing": require("../assets/brand/mascot/reproducing.svg").default,
  "mascot/scanning": require("../assets/brand/mascot/scanning.svg").default,
}

// Static component map for the logos and icon.
const ASSETS: Record<string, React.ComponentType<any>> = {
  "logo-mark": LogoMark,
  "logo-lockup": LogoLockup,
  "logo-tick": LogoTick,
  "logo-small": LogoSmall,
  trix: Trix,
  "app-icon": AppIcon,
  ...MASCOT_MODULES,
}

export type SvgName = keyof typeof ASSETS

export interface SvgImageProps {
  /** Asset name, e.g. "logo-lockup", "mascot/greeting", "trix". */
  name: SvgName
  width: number
  height: number
  style?: ViewStyle
  /** accessibilityLabel for screen readers. */
  accessibilityLabel?: string
}

/**
 * Renders a named SVG asset. Logo and mascot files carry their own fills,
 * so pass a `style` with `tintColor` to re-color when needed.
 */
export function SvgImage({ name, width, height, style, accessibilityLabel }: SvgImageProps) {
  const Asset = ASSETS[name]
  if (!Asset) {
    return null
  }
  return <Asset width={width} height={height} style={style} accessibilityLabel={accessibilityLabel} />
}

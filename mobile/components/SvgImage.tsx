/**
 * Renders SVG assets from mobile/assets/brand/ using react-native-svg.
 *
 * SVG files are bundled with the app as static assets and loaded via SvgUri
 * from the bundle resource URI. This avoids needing inline XML for large files.
 */
import { StyleSheet, ViewStyle, Platform, Image } from "react-native"
import { SvgUri } from "react-native-svg"

// Static asset requires - resolved at bundler time on native.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const LOGO_MARK = require("../assets/brand/logo/logo-mark.svg")
// eslint-disable-next-line @typescript-eslint/no-var-requires
const LOGO_LOCKUP = require("../assets/brand/logo/logo-lockup.svg")
// eslint-disable-next-line @typescript-eslint/no-var-requires
const LOGO_TICK = require("../assets/brand/logo/logo-tick.svg")
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MASCOT_GREETING = require("../assets/brand/mascot/greeting.svg")
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MASCOT_OUT_OF_SCOPE = require("../assets/brand/mascot/out-of-scope.svg")

const ASSETS: Record<string, any> = {
  "logo-mark": LOGO_MARK,
  "logo-lockup": LOGO_LOCKUP,
  "logo-tick": LOGO_TICK,
  "mascot/greeting": MASCOT_GREETING,
  "mascot/out-of-scope": MASCOT_OUT_OF_SCOPE,
}

export function SvgAsset({
  name,
  width,
  height,
  style,
}: {
  name: string
  width: number
  height: number
  style?: ViewStyle
}) {
  const asset = ASSETS[name]
  if (!asset) {
    return null
  }

  if (Platform.OS === "web") {
    // On web, SvgUri can use the require directly.
    return <SvgUri width={width} height={height} uri={asset} style={style} />
  }

  const source = Image.resolveAssetSource(asset)
  return <SvgUri width={width} height={height} uri={source.uri} style={style} />
}

const styles = StyleSheet.create({})

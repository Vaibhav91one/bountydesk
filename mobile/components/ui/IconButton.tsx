/**
 * 22px stroke icon button. Icons are copied from docs/site/screens/c.js.
 * Uses react-native-svg so the paths render identically to the web screens.
 *
 * In c.js each inline SVG uses viewBox="0 0 24 24" with stroke-width 1.8,
 * stroke-linecap=round, stroke-linejoin=round, and fill=none.
 */
import { StyleSheet, Pressable } from "react-native"
import Svg, { Path } from "react-native-svg"
import type { ComponentProps } from "react"

// The icon path catalog from c.js. All paths use a 24x24 viewBox.
// Each path is the content of an <i data-icon="name"> element.
export const ICONS: Record<string, string> = {
  bell: 'M6 9a6 6 0 1112 0c0 5 2 6.5 2 6.5H4S6 14 6 9z M10 19a2 2 0 004 0',
  more: 'M5 12h14M5 12a2 2 0 110 0M12 12a2 2 0 110 0m7 0a2 2 0 110 0',
  back: 'M15 5l-7 7 7 7',
  chev: 'M9 5l7 7-7 7',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  share: 'M12 3v12M8 7l4-4 4 4M5 12v7a1 1 0 001 1h12a1 1 0 001-1v-7',
  home: 'M3 11l9-7.5 9 7.5v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z',
  queue: 'M3 13l2.5-7.5A2 2 0 017.4 4h9.2a2 2 0 011.9 1.5L21 13v5a2 2 0 01-2 2H5a2 2 0 01-2-2z M3 13h5l1 2h6l1-2h5',
  reports: 'M6 3h9l4 4v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z M14 3v5h5M8.5 13h7M8.5 17h5',
  search: 'M20 20l-4-4M11 7a4 4 0 100 8 4 4 0 000-8z',
  clock: 'M12 12v5M12 2a10 10 0 100 20 10 10 0 000-20z',
  terminal: 'M7 15l3-3-3-3M10 15h8',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5M12 12v9',
  chat: 'M4 6a2 2 0 012-2h12a2 2 0 012 2v9a2 2 0 01-2 2h-7l-5 4v-4H6a2 2 0 01-2-2z',
  open: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5',
  copy: 'M9 9h6v6H9zM9 9V5a1 1 0 011-1h8a1 1 0 011 1v8a1 1 0 01-1 1h-4',
  userplus: 'M10 8a3 3 0 100-6 3 3 0 000 6zM6 20v-1a4 4 0 014-4h4a4 4 0 014 4v1M19 12v6M16 15l3-3 3 3',
  github: 'M12 0C5.373 0 0 5.373 0 12.015c0 5.302 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.726-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.997.108-.776.417-1.305.76-1.603-2.665-.3-5.466-1.332-5.466-5.93 0-1.291.469-2.343 1.235-3.19-.124-.312-.535-1.571.117-3.276 0 0 1.008-.322 3.3 1.23A11.53 11.53 0 0112 5.803c1.008.008 2.023.136 3.003.404 2.29-1.551 3.295-1.23 3.295-1.23.655 1.705.244 2.964.118 3.276.77.847 1.233 1.904 1.233 3.195 0 4.61-3.338 5.63-5.476 5.921.43.371.81 1.102.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .32.216.695.825.576C20.565 22.092 24 17.592 24 12.015 24 5.373 18.627 0 12 0z',
  mail: 'M3 5a2 2 0 012-2h14a2 2 0 002 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5z M3.5 7l8.5 6 8.5-6',
  cog: 'M12 2.5v3m0 13v3M4.5 12h3m13 0h3M6.5 6.5l2.1 2.1M16.5 16.5l2.1 2.1M18.5 6.5l-2.1 2.1M7.5 16.5l-2.1-2.1',
  lock: 'M12 2a4 4 0 00-4 4v4H4v6h16v-6h-4V6a4 4 0 00-4-4zm0 11a2 2 0 100-4 2 2 0 100 4z',
  arrowup: 'M12 19V5M6 11l6-6 6 6',
  info: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 15a8 8 0 110-16 8 8 0 010 16zm0-4a1 1 0 000 0v-4a1 1 0 10-2 0v4a1 1 0 001 1zm0-7a1 1 0 100 2 1 1 0 000-2z',
  file: 'M6 3a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9l-4-4H6z M14 3l4 4v5H10V7h4z',
  upload: 'M12 16V4M7 9l5-5 5 5M5 14v5a1 1 0 001 1h12a1 1 0 001 1v-5',
  shield: 'M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3z',
  target: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 100-16 8 8 0 000 16zm0-2a6 6 0 110-12 6 6 0 110 12z',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 5v6h-6',
}

export type IconName = keyof typeof ICONS

interface IconButtonProps extends ComponentProps<typeof Pressable> {
  name: IconName
  size?: number
  stroke?: string
  strokeWidth?: number
  style?: any
}

export function Icon({
  name,
  size = 22,
  stroke = "currentColor",
  strokeWidth = 1.8,
}: {
  name: IconName
  size?: number
  stroke?: string
  strokeWidth?: number
}) {
  const path = ICONS[name]
  if (!path) return null
  // Some icons have multiple sub-paths. Split on M (move-to) commands.
  const paths = path.split(/(?=M)/g).filter((p) => p.trim())
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
    >
      {paths.map((p, i) => (
        <Path
          key={i}
          d={p.trim()}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      ))}
    </Svg>
  )
}

export function IconButton({
  name,
  size = 22,
  stroke,
  strokeWidth,
  style,
  onPress,
  ...rest
}: IconButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, styles.ib, style]}
      {...rest}
    >
      <Icon name={name} size={size} stroke={stroke} strokeWidth={strokeWidth} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  ib: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
})

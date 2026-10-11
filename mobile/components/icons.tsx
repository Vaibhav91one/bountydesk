/**
 * Inline SVG stroke icon set, copied verbatim from docs/site/screens/c.js.
 *
 * c.js builds each icon as raw SVG markup inside `<i data-icon="name">` and
 * lets c.css drive the paint (`svg.i { fill: none; stroke: currentColor;
 * stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round }`). The only
 * exceptions are the `more` dots, which c.js emits with an explicit
 * `fill="currentColor"` via the `D(x,y)` helper.
 *
 * To keep the native icons pixel-identical to the mockups, every element
 * (Path, Circle, Rect, Line, Polyline) and every attribute from c.js is
 * reproduced here. The <Icon> component applies the c.css defaults as props.
 */
import Svg, { Path, Circle, Rect, Line, Polyline, type GProps, type PathProps, type CircleProps, type RectProps, type LineProps, type PolylineProps } from "react-native-svg"

type SvgElement =
  | { type: "path"; props: PathProps }
  | { type: "circle"; props: CircleProps }
  | { type: "rect"; props: RectProps }
  | { type: "line"; props: LineProps }
  | { type: "polyline"; props: PolylineProps }

// Helper that mirrors c.js `D(x,y)`: a 1.2-radius dot filled with currentColor.
const dot = (x: number, y: number): SvgElement => ({
  type: "circle",
  props: { cx: x, cy: y, r: 1.2, fill: "currentColor" },
})

/**
 * The icon catalog, keyed by data-icon name. Each value is the exact sequence
 * of SVG elements c.js writes, with their exact attributes. Path data, circle
 * centers/radii, rect boxes, line endpoints and polyline points are copied
 * verbatim and are not normalized.
 */
export const ICONS: Record<string, SvgElement[]> = {
  bell: [
    { type: "path", props: { d: "M6 9a6 6 0 1112 0c0 5 2 6.5 2 6.5H4S6 14 6 9z" } },
    { type: "path", props: { d: "M10 19a2 2 0 004 0" } },
  ],
  more: [dot(5, 12), dot(12, 12), dot(19, 12)],
  back: [{ type: "path", props: { d: "M15 5l-7 7 7 7" } }],
  chev: [{ type: "path", props: { d: "M9 5l7 7-7 7" } }],
  check: [{ type: "path", props: { d: "M5 12.5l4.5 4.5L19 7.5" } }],
  x: [
    { type: "line", props: { x1: 6, y1: 6, x2: 18, y2: 18 } },
    { type: "line", props: { x1: 18, y1: 6, x2: 6, y2: 18 } },
  ],
  plus: [
    { type: "line", props: { x1: 12, y1: 5, x2: 12, y2: 19 } },
    { type: "line", props: { x1: 5, y1: 12, x2: 19, y2: 12 } },
  ],
  share: [
    { type: "path", props: { d: "M12 3v12" } },
    { type: "path", props: { d: "M8 7l4-4 4 4" } },
    { type: "path", props: { d: "M5 12v7a1 1 0 001 1h12a1 1 0 001-1v-7" } },
  ],
  home: [{ type: "path", props: { d: "M3 11l9-7.5 9 7.5v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z" } }],
  queue: [
    { type: "path", props: { d: "M3 13l2.5-7.5A2 2 0 017.4 4h9.2a2 2 0 011.9 1.5L21 13v5a2 2 0 01-2 2H5a2 2 0 01-2-2z" } },
    { type: "path", props: { d: "M3 13h5l1 2h6l1-2h5" } },
  ],
  reports: [
    { type: "path", props: { d: "M6 3h9l4 4v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z" } },
    { type: "path", props: { d: "M14 3v5h5M8.5 13h7M8.5 17h5" } },
  ],
  // c.js: search icon (NOT the old arc-circle version)
  search: [
    { type: "circle", props: { cx: 11, cy: 11, r: 7 } },
    { type: "path", props: { d: "M20 20l-4-4" } },
  ],
  // c.js: clock icon (NOT the old full-circle version)
  clock: [
    { type: "circle", props: { cx: 12, cy: 12, r: 9 } },
    { type: "path", props: { d: "M12 7v5l3 2" } },
  ],
  terminal: [
    { type: "rect", props: { x: 3, y: 4.5, width: 18, height: 15, rx: 3 } },
    { type: "path", props: { d: "M7 10l3 2.5L7 15M12.5 15H17" } },
  ],
  cube: [
    { type: "path", props: { d: "M12 3l8 4.5v9L12 21l-8-4.5v-9z" } },
    { type: "path", props: { d: "M4 7.5l8 4.5 8-4.5M12 12v9" } },
  ],
  chat: [{ type: "path", props: { d: "M4 6a2 2 0 012-2h12a2 2 0 012 2v9a2 2 0 01-2 2h-7l-5 4v-4H6a2 2 0 01-2-2z" } }],
  open: [
    { type: "path", props: { d: "M14 4h6v6" } },
    { type: "path", props: { d: "M20 4l-9 9" } },
    { type: "path", props: { d: "M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" } },
  ],
  copy: [
    { type: "rect", props: { x: 9, y: 9, width: 11, height: 11, rx: 2.5 } },
    { type: "path", props: { d: "M5 15V6.5A2.5 2.5 0 017.5 4H15" } },
  ],
  userplus: [
    { type: "circle", props: { cx: 10, cy: 8, r: 3.5 } },
    { type: "path", props: { d: "M3.5 20a6.5 6.5 0 0113 0M19 8v6M16 11h6" } },
  ],
  // c.js: github glyph is NOT the GitHub logo — four circles + two paths
  github: [
    { type: "circle", props: { cx: 6, cy: 6, r: 2.5 } },
    { type: "circle", props: { cx: 6, cy: 18, r: 2.5 } },
    { type: "circle", props: { cx: 18, cy: 8, r: 2.5 } },
    { type: "path", props: { d: "M6 8.5v7M18 10.5c0 4.5-12 2-12 5" } },
  ],
  mail: [
    { type: "rect", props: { x: 3, y: 5, width: 18, height: 14, rx: 2.5 } },
    { type: "path", props: { d: "M3.5 7l8.5 6 8.5-6" } },
  ],
  cog: [
    { type: "circle", props: { cx: 12, cy: 12, r: 3 } },
    { type: "path", props: { d: "M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" } },
  ],
  lock: [
    { type: "rect", props: { x: 5, y: 11, width: 14, height: 9, rx: 2.5 } },
    { type: "path", props: { d: "M8 11V8a4 4 0 018 0v3" } },
  ],
  arrowup: [
    { type: "path", props: { d: "M12 19V5M6 11l6-6 6 6" } },
  ],
  info: [
    { type: "circle", props: { cx: 12, cy: 12, r: 9 } },
    { type: "path", props: { d: "M12 11v5.5M12 7.8v.4" } },
  ],
  file: [
    { type: "path", props: { d: "M6 3h9l4 4v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z" } },
    { type: "path", props: { d: "M14 3v5h5" } },
  ],
  upload: [
    { type: "path", props: { d: "M12 16V4M7 9l5-5 5 5M5 14v5a1 1 0 001 1h12a1 1 0 001-1v-5" } },
  ],
  shield: [{ type: "path", props: { d: "M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z" } }],
  target: [
    { type: "circle", props: { cx: 12, cy: 12, r: 9 } },
    { type: "circle", props: { cx: 12, cy: 12, r: 4.5 } },
  ],
  refresh: [{ type: "path", props: { d: "M20 11a8 8 0 10-2.3 5.7M20 5v6h-6" } }],
}

export type IconName = keyof typeof ICONS

interface IconProps {
  name: IconName
  size?: number
  stroke?: string
  strokeWidth?: number
}

const renderElement = (el: SvgElement, i: number, stroke: string, strokeWidth: number) => {
  const key = `${el.type}-${i}`
  // c.css paints all `svg.i` as stroke icons; the only explicit fill is the
  // `more` dot helper, which carries fill="currentColor".
  switch (el.type) {
    case "path":
      return <Path key={key} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none" {...el.props} />
    case "circle":
      return <Circle key={key} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none" {...el.props} />
    case "rect":
      return <Rect key={key} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none" {...el.props} />
    case "line":
      return <Line key={key} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none" {...el.props} />
    case "polyline":
      return <Polyline key={key} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none" {...el.props} />
  }
}

/**
 * Renders an icon exactly as c.js would inject it: a 24x24 viewBox with the
 * c.css stroke defaults (stroke-width 1.8, round caps and joins). The `more`
 * icon's circles carry an explicit fill via c.js's D() helper, and every
 * element attribute matches c.js verbatim.
 */
export function Icon({ name, size = 22, stroke = "currentColor", strokeWidth = 1.8 }: IconProps) {
  const cells = ICONS[name]
  if (!cells) return null
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {cells.map((el, i) => renderElement(el, i, stroke, strokeWidth))}
    </Svg>
  )
}

// Re-exported by ui/IconButton for the shared chrome.
export { renderElement }
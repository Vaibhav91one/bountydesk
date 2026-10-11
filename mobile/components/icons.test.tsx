/**
 * Renders every icon name from the c.js catalog without throwing.
 * Guards against regressions where a path string is malformed or an element
 * type is unsupported by react-native-svg.
 */
import React from "react"
import { render } from "@testing-library/react-native"
import { Icon, ICONS } from "@/components/icons"

const names = Object.keys(ICONS)

// The full c.js icon set, in c.js's own order.
const EXPECTED_NAMES = [
  "bell", "more", "back", "chev", "check", "x", "plus", "share",
  "home", "queue", "reports", "search", "clock", "terminal", "cube",
  "chat", "open", "copy", "userplus", "github", "mail", "cog",
  "lock", "arrowup", "info", "file", "upload", "shield", "target", "refresh",
]

// Element-type counts per icon, mirroring docs/site/screens/c.js exactly.
const EXPECTED_COUNTS: Record<string, Record<string, number>> = {
  bell: { RNSVGCircle: 0, RNSVGPath: 2 },
  more: { RNSVGCircle: 3, RNSVGPath: 0 },
  back: { RNSVGPath: 1 },
  chev: { RNSVGPath: 1 },
  check: { RNSVGPath: 1 },
  x: { RNSVGRect: 0, RNSVGLine: 2 },
  plus: { RNSVGLine: 2 },
  share: { RNSVGPath: 3 },
  home: { RNSVGPath: 1 },
  queue: { RNSVGPath: 2 },
  reports: { RNSVGPath: 2 },
  search: { RNSVGCircle: 1, RNSVGPath: 1 },
  clock: { RNSVGCircle: 1, RNSVGPath: 1 },
  terminal: { RNSVGRect: 1, RNSVGPath: 1 },
  cube: { RNSVGPath: 2 },
  chat: { RNSVGPath: 1 },
  open: { RNSVGPath: 3 },
  copy: { RNSVGRect: 1, RNSVGPath: 1 },
  userplus: { RNSVGCircle: 1, RNSVGPath: 1 },
  github: { RNSVGCircle: 3, RNSVGPath: 1 },
  mail: { RNSVGRect: 1, RNSVGPath: 1 },
  cog: { RNSVGCircle: 1, RNSVGPath: 1 },
  lock: { RNSVGRect: 1, RNSVGPath: 1 },
  arrowup: { RNSVGPath: 1 },
  info: { RNSVGCircle: 1, RNSVGPath: 1 },
  file: { RNSVGPath: 2 },
  upload: { RNSVGPath: 1 },
  shield: { RNSVGPath: 1 },
  target: { RNSVGCircle: 2 },
  refresh: { RNSVGPath: 1 },
}

const countElements = (text: string) => (type: string) => (text.match(new RegExp(type, "g")) || []).length

describe("icons", () => {
  it("exports the complete c.js icon set in order", () => {
    expect(names).toEqual(EXPECTED_NAMES)
  })

  it("renders each icon by name without throwing", async () => {
    for (const name of names) {
      const { toJSON } = await render(<Icon name={name as keyof typeof ICONS} />)
      expect(toJSON()).not.toBeNull()
    }
  })

  it("renders exactly the element types c.js declares for each icon", async () => {
    for (const name of names) {
      const { toJSON } = await render(<Icon name={name as keyof typeof ICONS} />)
      const text = JSON.stringify(toJSON())
      const cnt = countElements(text)
      const expected = EXPECTED_COUNTS[name]
      for (const [type, n] of Object.entries(expected)) {
        expect(cnt(type)).toBe(n)
      }
    }
  })

  it("renders the more icon as three filled dot circles at x=5,12,19", async () => {
    const { toJSON } = await render(<Icon name="more" />)
    const text = JSON.stringify(toJSON())
    const cxs = (text.match(/"cx":(\s*)(\d+)/g) || []).map((m) => +m.replace(/\D/g, ""))
    expect(cxs).toEqual(expect.arrayContaining([5, 12, 19]))
    expect(countElements(text)("RNSVGCircle")).toBe(3)
  })

  it("renders the github icon as c.js's glyph, not the GitHub logo", async () => {
    const { toJSON } = await render(<Icon name="github" />)
    const text = JSON.stringify(toJSON())
    // c.js: three circles + one path (the two sub-paths live in one <path d>)
    expect(countElements(text)("RNSVGCircle")).toBe(3)
    expect(countElements(text)("RNSVGPath")).toBe(1)
    expect(text).not.toContain("M12 0C5.373")
  })
})

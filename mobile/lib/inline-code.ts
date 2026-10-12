/**
 * Splits a drafted comment into plain and `code` runs for display (the mockups style the code
 * runs). Rejoining the runs with their backticks gives the input back byte for byte, so styling
 * never changes which text is approved: the hash always comes from the API, not from this.
 */
export interface Segment {
  text: string
  code: boolean
}

export function splitInlineCode(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), code: false })
    out.push({ text: m[1], code: true })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), code: false })
  return out
}

/** Inverse of splitInlineCode, used by the tests to prove nothing is lost. */
export const joinSegments = (segs: Segment[]): string => segs.map((s) => (s.code ? `\`${s.text}\`` : s.text)).join("")

import { ageText } from "./age"

const now = Date.parse("2026-10-12T12:00:00Z")
const ago = (min: number) => new Date(now - min * 60_000).toISOString()

describe("ageText", () => {
  it.each([
    [0, "just now"],
    [12, "12 min"],
    [60, "1 h"],
    [180, "3 h"],
    [1440, "Yesterday"],
    [2880, "2 d"],
    [10080, "1 wk"],
  ])("%i minutes", (min, text) => expect(ageText(ago(min), false, now)).toBe(text))

  it("adds ago except for Yesterday and just now", () => {
    expect(ageText(ago(34), true, now)).toBe("34 min ago")
    expect(ageText(ago(1440), true, now)).toBe("Yesterday")
  })
})

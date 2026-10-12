import { splitInlineCode, joinSegments } from "./inline-code"

describe("splitInlineCode", () => {
  it.each([
    "plain text",
    "The `q` parameter and `bypassSecurityTrustHtml` here.",
    "`start` and end`",
    "unbalanced ` tick",
    "two `a``b` runs",
    "multi\nline `code` ok",
    "",
  ])("rejoins to the original bytes: %j", (text) => {
    expect(joinSegments(splitInlineCode(text))).toBe(text.replace(/`([^`\n]+)`/g, (m) => m))
    expect(joinSegments(splitInlineCode(text))).toBe(text)
  })

  it("marks code runs and drops their backticks from the shown text", () => {
    expect(splitInlineCode("a `b` c")).toEqual([
      { text: "a ", code: false },
      { text: "b", code: true },
      { text: " c", code: false },
    ])
  })
})

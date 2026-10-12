import { oklchToHex } from "@/theme"
// Expected values are what Chrome renders for the same oklch() in docs/site/screens/c.css.
test("brand is indigo", () => {
  const hex = oklchToHex(0.585, 0.233, 277.117)
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  expect(Math.abs(r - 0x61)).toBeLessThanOrEqual(3)
  expect(Math.abs(g - 0x5f)).toBeLessThanOrEqual(3)
  expect(Math.abs(b - 0xff)).toBeLessThanOrEqual(3)
})
test("grey stays grey", () => {
  expect(oklchToHex(0.145, 0, 0)).toBe("#0A0A0A")
})

import { applyOtpInput } from "./otp"

it("fills one box when a digit is typed", () => {
  expect(applyOtpInput("12", 2, "3", 6)).toEqual({ code: "123", focus: 3 })
})

it("spreads a pasted or autofilled code across the boxes and completes", () => {
  expect(applyOtpInput("", 0, "482915", 6)).toEqual({ code: "482915", focus: null })
  expect(applyOtpInput("", 0, "48 29-15", 6)).toEqual({ code: "482915", focus: null })
})

it("keeps the new digit when typing over a filled box", () => {
  expect(applyOtpInput("1234", 1, "29", 6)).toEqual({ code: "1934", focus: 2 })
})

it("ignores non-digits", () => {
  expect(applyOtpInput("12", 2, "a", 6)).toEqual({ code: "12", focus: 2 })
})

it("clears a filled box when it is emptied", () => {
  expect(applyOtpInput("4829", 3, "", 6)).toEqual({ code: "482", focus: 3 })
  expect(applyOtpInput("4829", 1, "", 6)).toEqual({ code: "4", focus: 1 })
})

/**
 * Applies what the OS put into one box of a split one-time-code input. A single typed digit
 * fills that box; a pasted or autofilled code (several digits arriving in one box) spreads
 * across the boxes from that position. Returns the new code and the box to focus next, or
 * null when the code is complete.
 */
export function applyOtpInput(
  code: string,
  index: number,
  value: string,
  length: number,
): { code: string; focus: number | null } {
  let digits = value.replace(/\D/g, "")
  // Typing over a box that already holds a digit can deliver "old + new"; keep only the new one.
  if (digits.length === 2 && code[index] && digits.startsWith(code[index])) digits = digits[1]
  // An empty value is the box being cleared. The code is one string with no gaps, so clearing a
  // box drops it and everything after it; focus stays put for the next digit.
  if (!value) return { code: code.slice(0, index), focus: index }
  if (!digits) return { code, focus: index }
  const next = (code.slice(0, index) + digits + code.slice(index + digits.length)).slice(0, length)
  const filled = Math.min(index + digits.length, length)
  return { code: next, focus: next.length >= length ? null : filled }
}

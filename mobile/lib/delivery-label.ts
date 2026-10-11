/** The human channel name for a verdict's delivery, from the delivery target the worker recorded. */
export function deliveryLabel(channel: string, target: string | null | undefined): string {
  if (target) {
    if (/^github:/.test(target) && /:issue:/.test(target)) return "Comment on GitHub issue"
    if (/^github:/.test(target) && /:advisory:/.test(target)) return "Update security advisory"
    if (target.includes("@")) return "Email to reporter"
  }
  if (channel === "github") return "Comment on GitHub issue"
  return channel || "Unknown"
}

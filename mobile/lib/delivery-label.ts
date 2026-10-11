/**
 * The human channel name for where a verdict goes. Before a decision there is no delivery row, so
 * the case file's deliveryChannel decides (an email report bound to an advisory-capable repo is
 * "advisory"); once a delivery exists its recorded target is the more exact answer.
 */
export function deliveryLabel(deliveryChannel: string | null | undefined, target?: string | null): string {
  if (target) {
    if (/^github:/.test(target) && /:issue:/.test(target)) return "Comment on GitHub issue"
    if (/^github:/.test(target) && /:advisory:/.test(target)) return "GitHub security advisory"
    if (target.includes("@")) return "Email to reporter"
  }
  switch (deliveryChannel) {
    case "github":
      return "Comment on GitHub issue"
    case "advisory":
      return "GitHub security advisory"
    case "email":
    case "upload":
      // Upload replies ride the email transport to the contact the uploader verified.
      return "Email to reporter"
    default:
      return deliveryChannel || "Unknown"
  }
}

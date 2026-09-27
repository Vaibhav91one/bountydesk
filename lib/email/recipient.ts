import { isReviewerEmail } from "@/lib/auth/reviewers";

/**
 * May BountyDesk mail this report's contact?
 *
 * Two kinds of address qualify, and nothing else. An allowlisted reviewer, re-read from the
 * allowlist on every call so a removal takes effect at once. Or the outside sender whose mail
 * passed SPF and DKIM at intake, which intake recorded as `verifiedSender` next to the contact.
 * The second is checked by equality with the stored value rather than by a flag, so a contact
 * that was edited after intake stops qualifying: the proof was for one address, not for the
 * report.
 */
export async function isVerifiedEmailRecipient(report: {
  reporterContact: string | null;
  verifiedSender: string | null;
}): Promise<boolean> {
  const contact = report.reporterContact?.trim().toLowerCase() ?? "";
  if (!contact) return false;
  const verified = report.verifiedSender?.trim().toLowerCase() ?? "";
  if (verified && verified === contact) return true;
  return isReviewerEmail(contact);
}

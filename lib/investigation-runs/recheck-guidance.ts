import { redactReviewerText } from "@/lib/reviewer-chat/context";

/**
 * The fixed instruction every re-check starts with. The browser never sends it: the server
 * composes the final guidance so a request cannot replace the default with its own text.
 */
export const DEFAULT_RECHECK_GUIDANCE =
  "The reviewer asked for a fresh look at this report. Investigate it from scratch and draft your own conclusion.";

/** Must stay at or below GUIDANCE_MAX_LENGTH in recheck.ts once the default and header are added. */
export const MAX_RECHECK_NOTE_LENGTH = 3_500;

const NOTE_HEADER = "\n\nReviewer note:\n";

// The re-check turn wraps guidance in these markers. redactReviewerText only strips the chat
// path's delimiters, so a note could otherwise close the wrapper and pose as platform text.
const GUIDANCE_DELIMITER = /\[\/?UNTRUSTED_REVIEWER_GUIDANCE\]/gi;

/** Strip secrets and the wrapper delimiters from reviewer-authored text. */
export function sanitizeReviewerGuidance(value: string): string {
  return redactReviewerText(value).replace(GUIDANCE_DELIMITER, "[redacted delimiter]");
}

/** The default instruction, plus the reviewer's optional note when it has any content. */
export function composeRecheckGuidance(note?: string | null): string {
  // Cap after redaction: a short secret can be replaced by a longer marker.
  const clean = sanitizeReviewerGuidance(note ?? "").slice(0, MAX_RECHECK_NOTE_LENGTH).trim();
  return clean ? `${DEFAULT_RECHECK_GUIDANCE}${NOTE_HEADER}${clean}` : DEFAULT_RECHECK_GUIDANCE;
}

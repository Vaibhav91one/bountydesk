import { isReviewer } from "@/lib/auth/reviewers";

// A line that starts with optional spaces or tabs, then `/reproduce` on a word boundary, then
// anything. The line anchor keeps mid-sentence prose like "please /reproduce this" from
// matching, and the word boundary keeps `/reproducer` from matching while still allowing a
// trailing argument after a space. Case-insensitive and multi-line so the command can sit
// anywhere in a report body.
const REPRODUCE_LINE = /^[ \t]*\/reproduce\b[ \t]*(.*)$/im;

/**
 * Look for a `/reproduce` command in an issue body.
 *
 * Args are captured but unused for now: the gate only needs `matched`. Reserving them here
 * means a future `/reproduce --profile x` does not have to change the matcher.
 */
export function parseReproduceCommand(body: string | null | undefined): {
  matched: boolean;
  args: string;
} {
  const match = body ? REPRODUCE_LINE.exec(body) : null;
  return { matched: match !== null, args: match ? match[1].trim() : "" };
}

/**
 * A run is requested only when an authorized reviewer wrote the command. Both checks live
 * together because a future issue_comment handler needs the same pair, and because the actor
 * check is the security half: these repositories can be public, so an unauthenticated
 * `/reproduce` from a stranger would be a free way to spend the sandbox budget.
 */
export function reproductionRequested(
  body: string | null | undefined,
  senderId: number | undefined,
): boolean {
  if (senderId === undefined) return false;
  return parseReproduceCommand(body).matched && isReviewer(senderId);
}

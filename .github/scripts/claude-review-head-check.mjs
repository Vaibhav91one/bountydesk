import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Only the workflow token can post the summary. Anyone who can comment could paste the marker, so a
// marker in someone else's comment is ignored.
const REVIEWER = "github-actions[bot]";
const MARKER = /^<!-- claude-review head=([0-9a-f]{40}) -->/;

/** The head sha named by the latest Claude review summary, or null when there is none. */
export function reviewedHead(comments) {
  let head = null;
  for (const comment of comments) {
    if (comment?.user?.login !== REVIEWER) continue;
    const match = MARKER.exec((comment.body ?? "").trimStart());
    // The API lists issue comments oldest first, so the last match is the latest summary.
    if (match) head = match[1];
  }
  return head;
}

export function checkReviewHead(comments, head) {
  const reviewed = reviewedHead(comments);
  if (reviewed === null) {
    return { ok: false, message: `No Claude review summary on this pull request; head is ${head}.` };
  }
  if (reviewed !== head) {
    return { ok: false, message: `The latest Claude review covers ${reviewed}, not the head ${head}.` };
  }
  return { ok: true, message: `The latest Claude review covers the head ${head}.` };
}

// `gh api --paginate --slurp` writes one array per page.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [commentsFile, head] = process.argv.slice(2);
  const comments = JSON.parse(readFileSync(commentsFile, "utf8")).flat();
  const result = checkReviewHead(comments, head);
  console.log(result.message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Claude review head check\n\n${result.message}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

import { ne } from "drizzle-orm";

import { and, db, desc, isNull, report } from "@/lib/db";
import { repositoryMentions } from "@/lib/targets/suggest";

/**
 * Duplicate candidates for a report at the gate: the existing reports whose wording is closest,
 * with same-target reports ranked above cross-project ones.
 *
 * This is the "semantically similar reports go to a human as top-k candidates" rule and nothing
 * more. A score is a hint beside a report link. Nothing here closes, links or replies; only a
 * reviewer's "Mark duplicate" does, and they may pick a report that is not on this list.
 *
 * ponytail: Jaccard over word sets, boosted by shared github.com links, computed in the worker.
 * The repo signal is what stops a NodeGoat login report standing in for a Juice Shop login report
 * on the word "login" alone, and lifts a same-repo paraphrase over the trust line. Upgrade to
 * pg_trgm or embeddings once the report table is large or the misses start to matter.
 */
const SCAN_LIMIT = 500;
const TOP_K = 3;
const MIN_SCORE = 0.2;
const MAX_TEXT_CHARS = 20_000;
// A shared linked repository multiplies the word-overlap score. Multiplicative, not additive, so a
// same-repo report with almost no text in common (a different bug in the same app) stays low, while
// a genuine paraphrase of the same bug clears the trust line reviewers read the score against.
const SAME_REPO_BOOST = 1.6;

const STOPWORDS = new Set(
  "the and for with that this from have has was were are but not you your our can will would should could into when then than they them their there here what which who how why all any also been being its it's just more most some such only other about over after before because while where does did doing had".split(
    " ",
  ),
);

export type DuplicateCandidate = { reportId: string; title: string; score: number };

export function wordSet(text: string): Set<string> {
  // Drop links before tokenising. A shared link would otherwise leak host and path tokens (github,
  // com, the owner, the repo slug) into the word overlap and double-count the repo signal that
  // repoSet already carries. The github.com case is stripped scheme-optional, exactly the way
  // repositoryMentions matches it, so a bare github.com/owner/repo cannot leak its tokens while
  // still counting for the boost. Any other scheme-qualified URL goes too.
  const prose = text
    .slice(0, MAX_TEXT_CHARS)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/(?:www\.)?github\.com\/\S+/gi, " ");
  const words = prose.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// Lowercased so matching follows GitHub's case-insensitive naming; repositoryMentions keeps the
// reporter's spelling, which we do not need here.
function repoSet(text: string): Set<string> {
  return new Set(repositoryMentions(text).map((name) => name.toLowerCase()));
}

function sharesAny(a: Set<string>, b: Set<string>): boolean {
  for (const name of a) if (b.has(name)) return true;
  return false;
}

export function rankCandidates(
  text: string,
  rows: { id: string; title: string; body: string }[],
): DuplicateCandidate[] {
  const target = wordSet(text);
  const targetRepos = repoSet(text);

  const scored = rows.map((row) => {
    const rowText = `${row.title}\n${row.body}`;
    const rowRepos = repoSet(rowText);
    // Only meaningful when the target itself links a repo; otherwise there is nothing to match on
    // and every candidate falls back to plain word overlap.
    const sharesRepo = targetRepos.size > 0 && sharesAny(targetRepos, rowRepos);
    // Both sides name a repo and they disagree: a different project that only shares generic words.
    const crossProject = targetRepos.size > 0 && rowRepos.size > 0 && !sharesRepo;
    const base = jaccard(target, wordSet(rowText));
    const score = sharesRepo ? Math.min(1, base * SAME_REPO_BOOST) : base;
    return {
      reportId: row.id,
      title: row.title,
      score: Math.round(score * 100) / 100,
      sharesRepo,
      crossProject,
    };
  });

  const passing = scored.filter((candidate) => candidate.score >= MIN_SCORE);
  // A cross-project match (both sides link a repo, and they disagree) is usually noise beside a
  // same-repo one, so it does not float a NodeGoat report next to a Juice Shop one on "login" and
  // "injection". But a near-verbatim resend that happens to link a different repo (a fork, a rename,
  // a typo) can out-score every same-repo match on text alone, and dropping the strongest duplicate
  // signal would defeat the top-k rule. So a cross-project candidate is cut only when it scores below
  // the best same-repo candidate. With no same-repo candidate the bar is 0 and none are cut.
  const bestSameRepo = Math.max(0, ...passing.filter((candidate) => candidate.sharesRepo).map((c) => c.score));
  return passing
    .filter((candidate) => !(candidate.crossProject && candidate.score < bestSameRepo))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K)
    .map(({ reportId, title, score }) => ({ reportId, title, score }));
}

/**
 * Candidates for one report. Hidden reports and reports already closed as duplicates are left
 * out: the first are test rows, and pointing at the second would chain one duplicate to another
 * instead of to the original.
 */
export async function findDuplicateCandidates(
  reportId: string,
  title: string,
  body: string,
): Promise<DuplicateCandidate[]> {
  const rows = await db
    .select({ id: report.id, title: report.title, body: report.body })
    .from(report)
    .where(and(ne(report.id, reportId), isNull(report.hiddenAt), isNull(report.duplicateOfReportId)))
    .orderBy(desc(report.createdAt))
    .limit(SCAN_LIMIT);
  return rankCandidates(`${title}\n${body}`, rows);
}

import { ne } from "drizzle-orm";

import { and, db, desc, isNull, report } from "@/lib/db";

/**
 * Duplicate candidates for a report at the gate: the existing reports whose wording is closest.
 *
 * This is the "semantically similar reports go to a human as top-k candidates" rule and nothing
 * more. A score is a hint beside a report link. Nothing here closes, links or replies; only a
 * reviewer's "Mark duplicate" does, and they may pick a report that is not on this list.
 *
 * ponytail: Jaccard over word sets of the newest SCAN_LIMIT reports, computed in the worker. Good
 * enough to put the obvious re-send and the same-bug-different-words report on top; upgrade to
 * pg_trgm or embeddings once the report table is large or the misses start to matter.
 */
const SCAN_LIMIT = 500;
const TOP_K = 3;
const MIN_SCORE = 0.2;
const MAX_TEXT_CHARS = 20_000;

const STOPWORDS = new Set(
  "the and for with that this from have has was were are but not you your our can will would should could into when then than they them their there here what which who how why all any also been being its it's just more most some such only other about over after before because while where does did doing had".split(
    " ",
  ),
);

export type DuplicateCandidate = { reportId: string; title: string; score: number };

export function wordSet(text: string): Set<string> {
  const words = text.slice(0, MAX_TEXT_CHARS).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function rankCandidates(
  text: string,
  rows: { id: string; title: string; body: string }[],
): DuplicateCandidate[] {
  const target = wordSet(text);
  return rows
    .map((row) => ({
      reportId: row.id,
      title: row.title,
      score: Math.round(jaccard(target, wordSet(`${row.title}\n${row.body}`)) * 100) / 100,
    }))
    .filter((candidate) => candidate.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);
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

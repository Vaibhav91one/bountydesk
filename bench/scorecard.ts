/**
 * Turn a results file from `bench/run.ts collect` into the scorecard: the overall card plus one per
 * vulnerability class. Offline and read-only, like score.ts; it only joins results to the corpus by
 * case id, so it never needs the database or the harness.
 *
 *   node --import tsx bench/scorecard.ts bench/.runs/<runId>.results.json
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { score, scoreByGroup, type CaseResult, type Scorecard } from "./score";

export type CorpusRow = { id: string; vulnClass: string };

export type FullScorecard = {
  overall: Scorecard;
  byClass: Record<string, Scorecard>;
};

export function buildScorecard(results: readonly CaseResult[], corpus: readonly CorpusRow[]): FullScorecard {
  const classOf = new Map(corpus.map((c) => [c.id, c.vulnClass]));
  const grouped = results.map((r) => {
    const group = classOf.get(r.id);
    // A result for an unknown case would otherwise vanish from the per-class view and leave the
    // overall and per-class totals disagreeing without any signal why.
    if (group === undefined) throw new Error(`buildScorecard: result for unknown case id ${r.id}`);
    return { ...r, group };
  });
  return { overall: score(results), byClass: scoreByGroup(grouped) };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function row(label: string, card: Scorecard): string {
  return [
    label.padEnd(16),
    String(card.total).padStart(3),
    pct(card.falsePositiveRate).padStart(8),
    pct(card.falseNegativeRate).padStart(8),
    pct(card.abstentionRate).padStart(8),
  ].join("  ");
}

export function renderScorecard(card: FullScorecard): string {
  const header = ["class".padEnd(16), "n".padStart(3), "FPR".padStart(8), "FNR".padStart(8), "abstain".padStart(8)].join("  ");
  const classes = Object.keys(card.byClass).sort();
  return [header, row("overall", card.overall), ...classes.map((c) => row(c, card.byClass[c]))].join("\n");
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error("usage: bench/scorecard.ts <results.json>");
  const { default: corpus } = await import("./corpus.json", { with: { type: "json" } });
  const { results } = JSON.parse(readFileSync(path, "utf8")) as { results: CaseResult[] };
  console.log(renderScorecard(buildScorecard(results, corpus.cases as CorpusRow[])));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

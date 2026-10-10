# Verdict-quality benchmark

Issue #346 asks for a measurement of the reproduction oracle's accuracy, not a self-reported
feeling that it's accurate. This is the starter corpus and scorer: 30 cases today, built to grow,
not a finished number to quote.

## Why invalid recall, not just a false-positive rate

Pentest-agent benchmarks (XBOW's `xbow-engineering/validation-benchmarks`, Cybench, CVE-Bench)
score flag capture: did the agent find and exploit the bug. They rarely measure what happens when
there is no bug to find. The one benchmark that scores valid-versus-invalid report triage with
labels drawn from real HackerOne final dispositions is arXiv 2511.18608, and its headline finding
is that models over-accept invalid reports: told a report is probably real, they say so more often
than they should. That is exactly BountyDesk's failure mode to avoid, since the whole pitch is a
reproduction oracle that does not rubber-stamp a bad report as `REPRODUCED`. So this benchmark's
central number is **invalid recall**: of the reports that should not come back `REPRODUCED`, how
many didn't.

## Target

The already-pinned BountyDesk demo target: the connected fork `Vaibhav91one/juice-shop` at commit
`1867b926c5f50e4e692dc9c8f61821413cebe0cd` (`v17.3.0`). Ground truth for the ten positive cases
comes from the project's own published solutions
(<https://pwning.owasp-juice.shop/companion-guide/latest/appendix/solutions.html>), cited per case
in `bench/corpus.json`.

A second target was scoped out of this starter set. Adding an XBOW validation-benchmarks app
(Apache-2.0, `xbow-engineering/validation-benchmarks`) would need its own connected repository,
its own `TargetProfile`, a built and verified Daytona snapshot, and its own ground truth read out
of that benchmark's flag format, none of which is cheap against Juice Shop already being live and
already carrying a published, independently-written solutions guide. Juice Shop only, for now;
widening to a second app is future work, not this corpus.

## The corpus

`bench/corpus.json`: 30 cases, 10 positive and 20 negative, split `dev` (10, roughly a third) and
`test` (20), fixed so the split never silently shifts between runs. Report bodies are written the
way a real reporter writes one: a title, a plain description of what they tried and what happened,
sometimes a curl command or a payload string. Nothing in a case's body hints at its expected
outcome; that only lives in `expected`, `negativeType` and `rationale`, which the scorer and this
document read, not the pipeline under test.

Positives (`expected: "REPRODUCED"`) are ten real, distinct bugs in the pinned build: SQL
injection login bypass, an IDOR on the basket endpoint, an exposed FTP directory, SQLi-based
schema exfiltration, a weak default admin credential, a guessable password-reset security
question, verbose error disclosure, a broken-access-control review-author spoof, a DOM XSS, and a
missing CSRF defense. One of them (`p-dom-xss-search`) is deliberately a client-side DOM XSS,
included because it is a known-hard case for an HTTP-only probe (see
`dom-xss-http-probe-blind.md` in project memory): a corpus that only contains bugs the probe can
already see would not tell us anything about that gap.

Negatives (`expected: "NOT_REPRODUCED"` or, for `unbound`, `"ANALYSIS_ONLY"`) are twenty cases
across five labelled types, four of each:

- **fixed** — the described bug is not present in the pinned build (an invented endpoint, or a
  real bug class described through behavior/credentials/codes that do not actually trigger it).
- **wrong-payload** — a real endpoint and a real bug class, but the payload targets the wrong
  field or parameter (the injection is really in `email`, the report says `password`; and so on).
- **informative** — real, reproducible behavior with no security boundary crossed: self-XSS
  against the reporter's own content, a client route name visible in a bundled SPA, ordinary 404
  behavior described as if it were a leak.
- **duplicate** — the same root cause and the same endpoint as one of the ten positives, described
  with a different payload or from a different angle.
- **unbound** — a plausible-sounding report against a host with no connected repository and no
  `TargetProfile`, by design: per the architecture invariants, no bound target means the only
  correct outcome is `ANALYSIS_ONLY`, never `REPRODUCED` or `NOT_REPRODUCED`, whatever the report
  describes.

Hard negatives (`wrong-payload`, `informative`, `duplicate`) are built from the same app as the
positives on purpose: a benchmark where every negative is obviously off-topic would not pressure-
test the oracle at all.

## Scoring (`bench/score.ts`)

Pure, offline, no I/O: `score(results)` takes an array of `{ id, expected, actual }` and returns a
scorecard. `aggregate(scorecards)` takes several runs of the same corpus and reports the mean and
min/max of each rate, because a single run's rates are too noisy at this sample size to report on
their own (see the caveat below).

An actual `INCONCLUSIVE` is treated exactly like `ANALYSIS_ONLY`: both mean the pipeline declined
to make a definitive call, and the scorer does not care which of the two labels it used to decline.

Metrics:

- **3×3 confusion matrix** — expected × actual, both in `{REPRODUCED, NOT_REPRODUCED,
  ANALYSIS_ONLY}` (an actual `INCONCLUSIVE` collapses into `ANALYSIS_ONLY`'s column).
- **False-positive rate** — `REPRODUCED` claimed on a case whose ground truth is anything else, as
  a fraction of all negative (non-`REPRODUCED`) cases.
- **Invalid recall** — `1 - falsePositiveRate`: of the negative cases, the fraction scored
  anything but `REPRODUCED`. The headline number per the arXiv 2511.18608 framing above.
- **False-negative rate** — `NOT_REPRODUCED` or `ANALYSIS_ONLY` claimed on a case whose ground
  truth is `REPRODUCED` (a real bug missed), as a fraction of all positive cases.
- **Abstention rate** — fraction of all cases where the actual outcome was `ANALYSIS_ONLY` or
  `INCONCLUSIVE` while ground truth called for a definitive `REPRODUCED` or `NOT_REPRODUCED`:
  declined to call it either way.
- **Accuracy on non-abstained cases** — exact match rate over the cases that were not abstentions,
  so a pipeline cannot inflate its score by abstaining on everything hard.

`npm test` runs `bench/score.test.ts`, which exercises the metrics and the aggregation against
hand-built result sets; it does not touch the database or the corpus file.

## The sample-size caveat

Read any FPR or invalid-recall number from this corpus as a rough signal, not a certified rate.
With 20 negatives and zero observed false positives, the one-sided 95% Clopper-Pearson upper bound
on the true false-positive rate is still **about 14%**; at the roughly 30 negatives this starter
set edges toward with future additions, that upper bound is still around **10%**. A clean run does
not mean the oracle's real FPR is near zero, it means the sample is too small to rule out a FPR as
high as one in ten. Getting a bound tight enough to actually quote (say, under 2-3%) needs on the
order of **100+ negatives**, not 20 or 30. This starter set is sized to be buildable and to prove
the harness and scorer end to end; a number worth publishing externally waits for a bigger corpus.

## Running it

The runner (`bench/run.ts`) is not executed as part of this PR or CI. Filing a case starts a real
TrueForge session against a Daytona sandbox and needs that harness, its model credentials, and a
built Juice Shop snapshot, all running locally; this PR ships the harness, not a live benchmark run.

```bash
# 1. file every case (or --split=dev / --split=test / --ids=a,b) as a [bench]-titled report,
#    bound to the already-connected juice-shop target (seed it first if this DB has none:
#    npm run seed:target). Dry run without --commit.
npm run bench:run -- file --commit

# 2. drain the job queue until every filed report reaches a verdict or a terminal non-verdict
#    state (DENIED / OUT_OF_SCOPE / CANCELLED without ever drafting one):
npm run worker:jobs   # repeatedly, or:
npm run worker:daemon # left running

# 3. collect the agent's own drafted verdict per report into bench/.runs/<runId>.results.json
npm run bench:run -- collect --run=<runId>

# 4. score it (ad hoc, from a results file shaped { results: [{ id, expected, actual }] }):
node --import tsx -e '
  import { score } from "./bench/score.ts";
  const { results } = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  console.log(JSON.stringify(score(results), null, 2));
' bench/.runs/<runId>.results.json

# 5. cleanup: cancel every report the run filed (never approves or delivers anything).
#    Dry run without --commit.
npm run bench:run -- cleanup --run=<runId> --commit
```

Nothing here ever calls `publish_verdict`'s approval path or a delivery function. `collect` only
reads the `verdict` table; `cleanup` only moves reports to `CANCELLED` through the same
`retireReports` operator function `scripts/retire-test-reports.ts` already uses. If a filed
report somehow gets missed by cleanup, a human closes it by hand the same way: it is a `[bench]`-
titled report, `CANCELLED` is a legal move from any non-terminal state, and nothing about it
differs from any other leftover test report.

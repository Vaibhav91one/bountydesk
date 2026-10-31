import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

type CorpusCase = {
  id: string;
  split: "dev" | "test";
  kind: "positive" | "negative";
  expected: "REPRODUCED" | "NOT_REPRODUCED" | "ANALYSIS_ONLY";
  title: string;
  body: string;
  rationale: string;
  source: string;
  vulnClass?: string;
  negativeType?: "nonexistent" | "wrong-payload" | "informative" | "duplicate" | "unbound";
};

type Corpus = {
  target: { repo: string; ref: string; tag: string };
  cases: CorpusCase[];
};

const REQUIRED_FIELDS = ["id", "split", "kind", "expected", "title", "body", "rationale", "source"] as const;
const VALID_SPLITS = ["dev", "test"] as const;
const VALID_KINDS = ["positive", "negative"] as const;
const VALID_EXPECTED = ["REPRODUCED", "NOT_REPRODUCED", "ANALYSIS_ONLY"] as const;
const VALID_NEGATIVE_TYPES = ["nonexistent", "wrong-payload", "informative", "duplicate", "unbound"] as const;

const VALID_VULN_CLASSES = [
  "injection",
  "xss",
  "idor",
  "csrf",
  "info-disclosure",
  "broken-auth",
  "path-traversal",
  "business-logic",
  "other",
] as const;

function loadCorpus(): Corpus {
  return JSON.parse(
    readFileSync(resolve(import.meta.dirname, "corpus.json"), "utf-8"),
  );
}

test("corpus: has a target with repo, ref, and tag", () => {
  const corpus = loadCorpus();
  assert.ok(corpus.target, "target should exist");
  assert.equal(corpus.target.repo, "Vaibhav91one/juice-shop");
  assert.equal(corpus.target.ref, "1867b926c5f50e4e692dc9c8f61821413cebe0cd");
  assert.equal(corpus.target.tag, "v17.3.0");
});

test("corpus: has at least 110 cases", () => {
  const corpus = loadCorpus();
  assert.ok(corpus.cases.length >= 110, `expected >= 110 cases, got ${corpus.cases.length}`);
});

test("corpus: has at least 100 negatives", () => {
  const corpus = loadCorpus();
  const negatives = corpus.cases.filter((c) => c.kind === "negative");
  assert.ok(negatives.length >= 100, `expected >= 100 negatives, got ${negatives.length}`);
});

test("corpus: has at least 10 positives", () => {
  const corpus = loadCorpus();
  const positives = corpus.cases.filter((c) => c.kind === "positive");
  assert.ok(positives.length >= 10, `expected >= 10 positives, got ${positives.length}`);
});

test("corpus: every case has a unique id", () => {
  const corpus = loadCorpus();
  const ids = corpus.cases.map((c) => c.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.equal(duplicates.length, 0, `duplicate ids found: ${[...new Set(duplicates)].join(", ")}`);
  assert.equal(new Set(ids).size, ids.length);
});

test("corpus: every case has all required fields populated", () => {
  const corpus = loadCorpus();
  for (const c of corpus.cases) {
    for (const field of REQUIRED_FIELDS) {
      assert.ok(c[field], `case ${c.id} has empty or missing field: ${field}`);
    }
  }
});

test("corpus: every split is either 'dev' or 'test'", () => {
  const corpus = loadCorpus();
  const bad = corpus.cases.filter((c) => !VALID_SPLITS.includes(c.split));
  assert.equal(bad.length, 0, `invalid splits in: ${bad.map((c) => c.id).join(", ")}`);
});

test("corpus: every kind is either 'positive' or 'negative'", () => {
  const corpus = loadCorpus();
  const bad = corpus.cases.filter((c) => !VALID_KINDS.includes(c.kind));
  assert.equal(bad.length, 0, `invalid kinds in: ${bad.map((c) => c.id).join(", ")}`);
});

test("corpus: every expected value is valid", () => {
  const corpus = loadCorpus();
  const bad = corpus.cases.filter((c) => !VALID_EXPECTED.includes(c.expected));
  assert.equal(bad.length, 0, `invalid expected values in: ${bad.map((c) => c.id).join(", ")}`);
});

test("corpus: positive cases have expected REPRODUCED", () => {
  const corpus = loadCorpus();
  for (const c of corpus.cases) {
    if (c.kind === "positive") {
      assert.equal(c.expected, "REPRODUCED", `positive ${c.id} expected REPRODUCED but got ${c.expected}`);
    }
  }
});

test("corpus: negative cases have a negativeType", () => {
  const corpus = loadCorpus();
  for (const c of corpus.cases) {
    if (c.kind === "negative") {
      assert.ok(c.negativeType, `negative ${c.id} missing negativeType`);
      assert.ok(VALID_NEGATIVE_TYPES.includes(c.negativeType!), `negative ${c.id} has invalid negativeType: ${c.negativeType}`);
    }
  }
});

test("corpus: unbound cases have expected ANALYSIS_ONLY", () => {
  const corpus = loadCorpus();
  for (const c of corpus.cases) {
    if (c.kind === "negative" && c.negativeType === "unbound") {
      assert.equal(c.expected, "ANALYSIS_ONLY", `unbound ${c.id} expected ANALYSIS_ONLY but got ${c.expected}`);
    }
  }
});

test("corpus: each negativeType has its reviewed case count", () => {
  // Not 20 per type after the #346 label corrections moved cases between types.
  const expected: Record<string, number> = { nonexistent: 26, "wrong-payload": 22, informative: 10, duplicate: 22, unbound: 20 };
  const corpus = loadCorpus();
  const counts: Record<string, number> = {};
  for (const c of corpus.cases) {
    if (c.kind === "negative" && c.negativeType) {
      counts[c.negativeType] = (counts[c.negativeType] || 0) + 1;
    }
  }
  for (const type of VALID_NEGATIVE_TYPES) {
    assert.equal(counts[type] ?? 0, expected[type], `negativeType ${type} has ${counts[type] ?? 0} cases, expected ${expected[type]}`);
  }
});

test("corpus: dev/test split is roughly 1/3 dev, 2/3 test", () => {
  const corpus = loadCorpus();
  const dev = corpus.cases.filter((c) => c.split === "dev").length;
  const test = corpus.cases.filter((c) => c.split === "test").length;
  const total = corpus.cases.length;
  const devRatio = dev / total;
  assert.ok(devRatio > 0.25 && devRatio < 0.45, `dev ratio ${devRatio.toFixed(2)} is not roughly 1/3`);
  assert.equal(dev + test, total);
});

test("corpus: source field contains a valid URL or n/a marker", () => {
  const corpus = loadCorpus();
  for (const c of corpus.cases) {
    const src = c.source;
    assert.ok(
      src.startsWith("http://") || src.startsWith("https://") || src.startsWith("n/a"),
      `case ${c.id} has invalid source: ${src}`,
    );
  }
});

// The 30 original cases must keep their reviewed split and expected outcome verbatim.
const ORIGINAL_CASES: Array<{ id: string; split: string; expected: string }> = [
  { id: "p-sqli-login", split: "dev", expected: "REPRODUCED" },
  { id: "p-idor-basket", split: "dev", expected: "REPRODUCED" },
  { id: "p-ftp-listing", split: "dev", expected: "REPRODUCED" },
  { id: "p-sqli-exfil", split: "test", expected: "REPRODUCED" },
  { id: "p-default-admin-creds", split: "test", expected: "REPRODUCED" },
  { id: "p-forgot-password-weak-question", split: "test", expected: "REPRODUCED" },
  { id: "p-stacktrace-disclosure", split: "test", expected: "REPRODUCED" },
  { id: "p-review-author-spoof", split: "test", expected: "REPRODUCED" },
  { id: "p-dom-xss-search", split: "test", expected: "REPRODUCED" },
  { id: "p-csrf-profile-name", split: "test", expected: "REPRODUCED" },
  { id: "n-nonexistent-1", split: "dev", expected: "NOT_REPRODUCED" },
  { id: "n-nonexistent-2", split: "dev", expected: "NOT_REPRODUCED" },
  { id: "n-nonexistent-3", split: "test", expected: "NOT_REPRODUCED" },
  { id: "n-nonexistent-4", split: "test", expected: "NOT_REPRODUCED" },
  { id: "n-wrong-1", split: "dev", expected: "NOT_REPRODUCED" },
  { id: "n-wrong-2", split: "dev", expected: "NOT_REPRODUCED" },
  { id: "n-wrong-3", split: "test", expected: "NOT_REPRODUCED" },
  { id: "n-wrong-4", split: "test", expected: "NOT_REPRODUCED" },
  { id: "n-info-1", split: "dev", expected: "NOT_REPRODUCED" },
  { id: "n-info-2", split: "test", expected: "NOT_REPRODUCED" },
  { id: "n-info-3", split: "test", expected: "NOT_REPRODUCED" },
  { id: "n-info-4", split: "test", expected: "NOT_REPRODUCED" },
  { id: "n-dup-1", split: "dev", expected: "NOT_REPRODUCED" },
  { id: "n-dup-2", split: "test", expected: "NOT_REPRODUCED" },
  { id: "n-dup-3", split: "test", expected: "NOT_REPRODUCED" },
  { id: "n-dup-4", split: "test", expected: "NOT_REPRODUCED" },
  { id: "n-unbound-1", split: "dev", expected: "ANALYSIS_ONLY" },
  { id: "n-unbound-2", split: "test", expected: "ANALYSIS_ONLY" },
  { id: "n-unbound-3", split: "test", expected: "ANALYSIS_ONLY" },
  { id: "n-unbound-4", split: "test", expected: "ANALYSIS_ONLY" },
];

test("corpus: original 30 reviewed cases keep their original split and expected", () => {
  const corpus = loadCorpus();
  const byId = new Map(corpus.cases.map((c) => [c.id, c]));
  for (const orig of ORIGINAL_CASES) {
    const c = byId.get(orig.id);
    assert.ok(c, `original case ${orig.id} is missing from corpus`);
    assert.equal(c!.split, orig.split, `original case ${orig.id} changed split: expected ${orig.split}, got ${c!.split}`);
    assert.equal(c!.expected, orig.expected, `original case ${orig.id} changed expected: expected ${orig.expected}, got ${c!.expected}`);
  }
});

test("corpus: every case names a vulnerability class from the fixed list so the scorecard can break results down by class", () => {
  for (const c of loadCorpus().cases) {
    assert.ok(
      (VALID_VULN_CLASSES as readonly string[]).includes(c.vulnClass ?? ""),
      `${c.id} has vulnClass ${JSON.stringify(c.vulnClass)}`,
    );
  }
});

test("corpus: every class that has a positive case also has a negative case, so a class cannot score on positives alone", () => {
  const cases = loadCorpus().cases;
  const positiveClasses = new Set(cases.filter((c) => c.kind === "positive").map((c) => c.vulnClass));
  for (const cls of positiveClasses) {
    assert.ok(
      cases.some((c) => c.kind === "negative" && c.vulnClass === cls),
      `class ${cls} has positives but no negatives`,
    );
  }
});

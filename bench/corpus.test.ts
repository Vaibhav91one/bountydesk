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

test("corpus: each negativeType has at least 20 cases", () => {
  const corpus = loadCorpus();
  const counts: Record<string, number> = {};
  for (const c of corpus.cases) {
    if (c.kind === "negative" && c.negativeType) {
      counts[c.negativeType] = (counts[c.negativeType] || 0) + 1;
    }
  }
  for (const type of VALID_NEGATIVE_TYPES) {
    assert.ok(counts[type] >= 20, `negativeType ${type} has only ${counts[type] ?? 0} cases, expected >= 20`);
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

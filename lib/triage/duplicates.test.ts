import assert from "node:assert/strict";
import test from "node:test";

import { jaccard, rankCandidates, wordSet } from "./duplicates";

// Two live misses drove issue #236: a same-repo paraphrase of one bug scored too low to trust, and
// a cross-project report surfaced on shared generic words. These fixtures reproduce both against the
// pure ranking function, no database.
const JUICE = "https://github.com/Vaibhav91one/juice-shop";
const NODEGOAT = "https://github.com/OWASP/NodeGoat";

const target = {
  title: "SQL injection on the Juice Shop login form",
  body: `The login endpoint at ${JUICE} is vulnerable. Sending ' OR 1=1-- in the email field logs you in as the admin without a password.`,
};
const targetText = `${target.title}\n${target.body}`;

function bareScore(row: { title: string; body: string }): number {
  return jaccard(wordSet(targetText), wordSet(`${row.title}\n${row.body}`));
}

test("a same-repo paraphrase of the same bug is lifted over the trust line", () => {
  const paraphrase = {
    id: "paraphrase",
    title: "Juice Shop login accepts a crafted email as admin",
    // Same bug, different words, same linked repository.
    body: `On the Juice Shop login at ${JUICE}, a crafted value in the email field signs you in as the administrator with no password. Looks like unsanitised input reaching the query.`,
  };
  // Bare word overlap is the kind of low score (#236 saw 0.33 and 0.38) a reviewer skims past.
  assert.ok(bareScore(paraphrase) < 0.4, `fixture should be a low-overlap paraphrase, got ${bareScore(paraphrase)}`);

  const [candidate] = rankCandidates(targetText, [paraphrase]);
  assert.equal(candidate.reportId, "paraphrase");
  // The shared repo boosts it clear of the bare score and above where the score reads as a real lead.
  assert.ok(candidate.score > bareScore(paraphrase), "the shared repo should raise the score");
  assert.ok(candidate.score >= 0.4, `expected a trustworthy score, got ${candidate.score}`);
});

test("a cross-project report is dropped when a same-repo candidate exists", () => {
  const rows = [
    {
      id: "same-repo",
      title: "Login SQL injection in Juice Shop",
      body: `Auth bypass on the Juice Shop login at ${JUICE} using a SQL injection payload in the email field.`,
    },
    {
      id: "cross-project",
      title: "SQL injection on the NodeGoat login",
      // Shares login, injection, email, admin, tautology, but a different app.
      body: `The NodeGoat login at ${NODEGOAT} has a SQL injection letting you log in as admin through the email field with a tautology payload.`,
    },
  ];
  // Without the repo signal the cross-project report clears the floor on its own.
  assert.ok(bareScore(rows[1]) >= 0.2, `cross fixture should pass the bare floor, got ${bareScore(rows[1])}`);

  const ids = rankCandidates(targetText, rows).map((c) => c.reportId);
  assert.ok(ids.includes("same-repo"), "the same-repo report should rank");
  assert.ok(!ids.includes("cross-project"), "the cross-project report should be filtered out");
});

test("a cross-project report still surfaces when nothing shares the repo", () => {
  // No same-repo candidate to outrank it, so text overlap alone is all we have and it is kept.
  const rows = [
    {
      id: "cross-project",
      title: "SQL injection on the NodeGoat login",
      body: `The NodeGoat login at ${NODEGOAT} has a SQL injection letting you log in as admin through the email field with a tautology payload.`,
    },
  ];
  assert.deepEqual(
    rankCandidates(targetText, rows).map((c) => c.reportId),
    ["cross-project"],
  );
});

test("an exact re-send scores near the top", () => {
  const rows = [
    { id: "resend", title: target.title, body: target.body },
    {
      id: "cross-project",
      title: "SQL injection on the NodeGoat login",
      body: `The NodeGoat login at ${NODEGOAT} has a SQL injection through the email field.`,
    },
  ];
  const ranked = rankCandidates(targetText, rows);
  assert.equal(ranked[0].reportId, "resend");
  assert.ok(ranked[0].score >= 0.95, `expected an exact re-send near 1, got ${ranked[0].score}`);
});

test("a different bug in the same repo is not floated by the repo boost alone", () => {
  // Same linked repo, no real text overlap: the multiplicative boost cannot invent a candidate out
  // of a shared project, and URL tokens no longer leak into the word overlap either.
  const rows = [
    {
      id: "unrelated-same-repo",
      title: "Broken image on the about page",
      body: `The about page at ${JUICE} shows a broken logo when viewed on a small screen. Purely cosmetic, unrelated to any security concern.`,
    },
  ];
  assert.deepEqual(rankCandidates(targetText, rows), []);
});

test("jaccard and wordSet stay pure helpers the ranker builds on", () => {
  assert.equal(jaccard(new Set(["a"]), new Set()), 0);
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["a", "b"])), 1);
  // Stopwords, sub-three-character tokens, and a URL's host and path are all dropped.
  assert.deepEqual([...wordSet("the login form is XSS https://github.com/o/r")].sort(), ["form", "login", "xss"]);
});

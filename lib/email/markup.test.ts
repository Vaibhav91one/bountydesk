import assert from "node:assert/strict";
import test from "node:test";

import { outcomeOf, renderPayloadRows, renderVerdictEmail } from "./markup";

/**
 * The payload is agent-authored text that can echo prompt-injection content off an untrusted
 * target, and it lands in a mailbox that sanitises nothing. These are the tests that say so.
 */

const VERDICT_ID = "11111111-2222-3333-4444-555555555555";
const MARKER = `<!-- bountydesk-delivery:${VERDICT_ID} -->`;
const ORIGIN = "https://app.example";

function payload(body: string): string {
  return `${body}\n\n${MARKER}`;
}

/** The shape the live report 911fb70b actually carries, XSS string and all. */
const REAL = payload(
  [
    "## Outcome: ANALYSIS_ONLY",
    "",
    "## Summary",
    "",
    "Reporter describes a reflected XSS in the product search 'q' parameter. They supplied a",
    "concrete payload (<img src=x onerror=alert(1)>) and reproduction steps.",
    "",
    "## Findings",
    "",
    "### 1. Reflected XSS via product search 'q' parameter (HIGH)",
    "",
    "The 'q' parameter is reflected without escaping; /search?q=<img src=x onerror=alert(1)>",
    "is said to execute.",
  ].join("\n"),
);

/** Every tag the template itself writes. Anything else in the output came from the payload. */
const OURS =
  /^\/?(?:!doctype html|html|head|meta|title|body|table|tr|td|p|ul|ol|li|pre|code|strong|em|s|div|span|img|hr|br)\b/i;

function foreignTags(html: string): string[] {
  return [...html.matchAll(/<([^>]+)>/g)]
    .map((m) => m[1])
    .filter((tag) => !tag.startsWith("!--") && !OURS.test(tag));
}

test("a payload carrying a live XSS string produces no tag the template did not write", () => {
  const html = renderVerdictEmail(REAL, VERDICT_ID, ORIGIN);

  assert.deepEqual(foreignTags(html), [], "agent text became markup");
  assert.ok(!html.includes("<img src=x onerror"), "the payload's img tag is live");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "it should read as characters");
});

test("a script tag in the payload is text, not a script", () => {
  const html = renderVerdictEmail(payload("Try <script>alert(1)</script> here."), VERDICT_ID, ORIGIN);
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("the delivery marker survives exactly once, and as a real comment", () => {
  const html = renderVerdictEmail(REAL, VERDICT_ID, ORIGIN);
  assert.equal(html.split(MARKER).length, 2, "the marker must appear exactly once");
  // Escaped would mean a reader sees it, which is the bug this guards.
  assert.ok(!html.includes("&lt;!-- bountydesk-delivery"));
});

test("a payload missing its marker is refused rather than sent unmarked", () => {
  assert.throws(
    () => renderVerdictEmail("## Outcome: ANALYSIS_ONLY", VERDICT_ID, ORIGIN),
    /did not appear exactly once/,
  );
});

test("rendering is deterministic, because a retry must send identical bytes", () => {
  // Resend refuses a reuse of an idempotency key that carries a different body, so anything
  // time-dependent or random in here turns a safe replay into a mismatch that needs a human.
  assert.equal(
    renderVerdictEmail(REAL, VERDICT_ID, ORIGIN),
    renderVerdictEmail(REAL, VERDICT_ID, ORIGIN),
  );
});

test("a payload with no headings still renders, because two drivers write plain prose", () => {
  // lib/analysis/stub-driver.ts and scripts/seed-reports.ts both do. Degrading to paragraphs
  // beats throwing inside the delivery worker.
  const html = renderVerdictEmail(payload("Just a sentence with no structure at all."), VERDICT_ID, ORIGIN);
  assert.ok(html.includes("Just a sentence with no structure at all."));
  assert.deepEqual(foreignTags(html), []);
});

test("the outcome band is read from the payload, so it cannot disagree with the approved bytes", () => {
  assert.equal(outcomeOf(REAL), "ANALYSIS_ONLY");
  assert.equal(outcomeOf("## Outcome: REPRODUCED\n"), "REPRODUCED");
  assert.equal(outcomeOf("no outcome line here"), null);
  assert.equal(outcomeOf("## Outcome: SOMETHING_ELSE\n"), null);

  assert.ok(renderVerdictEmail(REAL, VERDICT_ID, ORIGIN).includes("Analysis only"));
});

test("a finding heading's severity becomes a chip without losing the title", () => {
  const html = renderPayloadRows("### 1. Reflected XSS via search q (HIGH)");
  assert.ok(html.includes("HIGH"));
  assert.ok(html.includes("Reflected XSS via search q"));
  assert.ok(!html.includes("(HIGH)"), "the severity should move into the chip, not be repeated");
});

test("a heading with no severity keeps its whole text rather than losing the tail", () => {
  const html = renderPayloadRows("### 1. Something (not a severity)");
  assert.ok(html.includes("Something (not a severity)"));
});

test("a link keeps its words but never its href", () => {
  // An agent-authored URL in a reporter's inbox is a phishing surface, and we gain nothing by
  // making it clickable.
  const html = renderPayloadRows("See [the report](https://evil.example/steal).");
  assert.ok(html.includes("the report"));
  assert.ok(!html.includes("evil.example"));
  assert.ok(!/<a\b/i.test(html));
});

test("a markdown image never becomes an img, so the body cannot beacon", () => {
  const html = renderPayloadRows("![tracker](https://evil.example/pixel.gif)");
  assert.ok(!html.includes("evil.example"));
  assert.ok(html.includes("tracker"));
});

test("a fenced block keeps its content escaped", () => {
  const html = renderPayloadRows("```\n<b>not bold</b>\n```");
  assert.ok(html.includes("&lt;b&gt;not bold&lt;/b&gt;"));
  assert.ok(!html.includes("<b>not bold</b>"));
});

test("the mascot is addressed at the origin it is given, with empty alt", () => {
  const html = renderVerdictEmail(REAL, VERDICT_ID, ORIGIN);
  assert.ok(html.includes(`${ORIGIN}/email/scanning.png`));
  // Decoration beside a wordmark: images are blocked by default, so it must carry no meaning.
  assert.ok(html.includes('alt=""'));
});

test("the outcome reads in words, not only in colour", () => {
  // Most clients block images and some readers cannot see the chip's colour at all.
  const reproduced = renderVerdictEmail(
    payload("## Outcome: REPRODUCED\n\n## Summary\n\nIt reproduced."),
    VERDICT_ID,
    ORIGIN,
  );
  assert.ok(reproduced.includes("Reproduced"));
  assert.ok(reproduced.includes("It reproduced."));
});

test("the outcome line is not printed twice when the band already says it", () => {
  // The band is the plainer wording, so the raw "## Outcome: ANALYSIS_ONLY" heading is dropped.
  const html = renderVerdictEmail(REAL, VERDICT_ID, ORIGIN);
  assert.ok(html.includes("Analysis only"), "the band still says it");
  assert.ok(!html.includes("ANALYSIS_ONLY"), "the raw heading should not be repeated");
});

test("a payload with an unrecognised outcome keeps its heading rather than losing it", () => {
  // No band is drawn for an outcome this renderer does not know, so dropping the line would
  // silently remove the only place the outcome appears.
  const html = renderVerdictEmail(payload("## Outcome: SOMETHING_NEW\n\nbody"), VERDICT_ID, ORIGIN);
  assert.ok(html.includes("Outcome: SOMETHING_NEW"));
});

test("a list nested inside a list item keeps its items, which are the reproduction commands", () => {
  // The exact shape the agent wrote on report 4c7c9bfa: numbered steps, with the URLs to open
  // and the console command indented under a step as a nested list. These were silently dropped
  // from the HTML part, so the reader got "for example:" followed by nothing.
  const html = renderPayloadRows(
    [
      "1) In the address bar, navigate to the search route, for example:",
      "   - /#/search?q=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E",
      "   - /#/search?q=%3Csvg%20onload%3Dalert(document.domain)%3E",
      "2) As an alternative, open the console and run:",
      "   - location.hash = '#/search?q=' + encodeURIComponent('<img src=x onerror=alert(1)>')",
    ].join("\n"),
  );

  assert.ok(html.includes("%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E"), "first example URL");
  assert.ok(html.includes("%3Csvg%20onload%3Dalert(document.domain)%3E"), "second example URL");
  assert.ok(html.includes("location.hash"), "the console command");
  // Nested, not flattened: an inner list sits inside an outer list item.
  assert.match(html, /<li[^>]*>[^]*<ul[^>]*>[^]*<li[^>]*>/);
});

test("markup inside a nested list item is still text", () => {
  // Recursing must not open a path around the escaping: the nested item above carries a live
  // payload, and it has to reach the reader as characters.
  const html = renderPayloadRows("- outer\n   - <img src=x onerror=alert(1)>\n");
  assert.ok(!html.includes("<img src=x"), "a nested item's markup became live");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
});

test("a code block inside a list item is kept and escaped", () => {
  const html = renderPayloadRows("1. run this:\n\n   ```\n   <b>curl</b> /x\n   ```\n");
  assert.ok(html.includes("&lt;b&gt;curl&lt;/b&gt; /x"));
  assert.ok(!html.includes("<b>curl</b>"));
});

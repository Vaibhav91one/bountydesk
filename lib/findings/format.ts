/**
 * A finding's description, split into the blocks it was written as.
 *
 * The agent writes prose with reproduction steps in it, and a single pre-wrapped paragraph puts
 * the steps, the observation and the impact in one undifferentiated wall. This finds the
 * structure that is already in the text so the case file can lay it out: a numbered or bulleted
 * run becomes a list, a line that is only a label becomes a heading, everything else is a
 * paragraph.
 *
 * Plain text in, plain text out. Nothing here interprets markdown or produces HTML: the agent
 * may have read prompt-injection content off an untrusted target, so its words stay words, and
 * the caller renders each block's text as text.
 */

export type DescriptionBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "steps"; items: string[] };

/** "1) ", "2. ", "- ", "* ", "• ". The marker is dropped; the list numbers itself. */
const STEP = /^(\d{1,3}[).:]|[-*•])\s+(.*)$/;

/**
 * A line that is only a label, like "Steps to reproduce:".
 *
 * The colon has to end the line. "Observed behavior: the request returned rows" is a sentence
 * that happens to start with a label, and turning that into a heading would drop its content.
 */
const HEADING = /^[^\s].{0,79}:$/;

export function describeFinding(description: string): DescriptionBlock[] {
  const blocks: DescriptionBlock[] = [];
  let paragraph: string[] = [];
  let steps: string[] | null = null;

  function endParagraph() {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  }

  function endSteps() {
    if (steps && steps.length > 0) blocks.push({ kind: "steps", items: steps });
    steps = null;
  }

  for (const raw of description.split("\n")) {
    const line = raw.trim();

    if (line.length === 0) {
      endParagraph();
      endSteps();
      continue;
    }

    const step = STEP.exec(line);
    if (step) {
      endParagraph();
      steps ??= [];
      steps.push(step[2].trim());
      continue;
    }

    // Inside a list, an indented line is the previous step continuing onto another line. An
    // unindented one has left the list, which is what separates the steps from the sentence
    // that follows them.
    if (steps && /^\s/.test(raw)) {
      steps[steps.length - 1] = `${steps[steps.length - 1]} ${line}`;
      continue;
    }
    endSteps();

    if (HEADING.test(line)) {
      endParagraph();
      blocks.push({ kind: "heading", text: line.slice(0, -1) });
      continue;
    }

    paragraph.push(line);
  }

  endParagraph();
  endSteps();

  return blocks;
}

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
  /** An ordered run the author numbered. Rendered with its own numbers, not the author's. */
  | { kind: "steps"; items: string[] }
  /** An unordered run. Kept apart from steps because bullets are not an order to follow. */
  | { kind: "bullets"; items: string[] }
  /** A fenced or indented run, kept exactly as written. The one place monospace belongs. */
  | { kind: "code"; text: string }
  /**
   * "Impact: arbitrary JavaScript execution…". The agent writes these constantly and they used
   * to disappear into the middle of a paragraph, which is most of why a finding read as a wall.
   * The label is split off so it can carry weight while its sentence stays prose.
   */
  | { kind: "labelled"; label: string; text: string };

/** "1) ", "2. ". The marker is dropped; the list numbers itself. */
const ORDERED = /^(\d{1,3}[).:])\s+(.*)$/;

/** "- ", "* ", "• ". Unordered, so nothing renumbers. */
const BULLET = /^([-*•])\s+(.*)$/;

/** ``` or ~~~, optionally with a language that we ignore: the content is shown, not highlighted. */
const FENCE = /^(```|~~~)/;

/**
 * "Impact: the request returned every row." A short label, then its sentence on the same line.
 *
 * Bounded at 40 characters and required to be followed by real content, so an ordinary sentence
 * that happens to contain a colon ("the URL is http://host: see below") is not torn in half. A
 * line that is *only* a label is a heading instead, and HEADING is tested first.
 */
const LABELLED = /^([A-Z][^:]{0,39}):\s+(\S.*)$/;

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
  let list: { kind: "steps" | "bullets"; items: string[] } | null = null;

  function endParagraph() {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  }

  function endList() {
    if (list && list.items.length > 0) blocks.push({ ...list });
    list = null;
  }

  const lines = description.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();

    // A fence runs to its closing fence, or to the end if the agent never closed it. Everything
    // between is content, including blank lines and anything that would otherwise look like a
    // list, so this is checked before all of them.
    if (FENCE.test(line)) {
      endParagraph();
      endList();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i].trim())) {
        body.push(lines[i]);
        i += 1;
      }
      if (body.length > 0) blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    if (line.length === 0) {
      endParagraph();
      endList();
      continue;
    }

    const ordered = ORDERED.exec(line);
    const bullet = ordered ? null : BULLET.exec(line);
    if (ordered || bullet) {
      endParagraph();
      const kind = ordered ? "steps" : "bullets";
      // A bullet run directly after a numbered one is a different list, not a continuation.
      if (list && list.kind !== kind) endList();
      list ??= { kind, items: [] };
      list.items.push((ordered ?? bullet!)[2].trim());
      continue;
    }

    // Inside a list, an indented line is the previous item continuing onto another line. An
    // unindented one has left the list, which is what separates the steps from the sentence
    // that follows them.
    if (list && /^\s/.test(raw)) {
      list.items[list.items.length - 1] = `${list.items[list.items.length - 1]} ${line}`;
      continue;
    }
    endList();

    if (HEADING.test(line)) {
      endParagraph();
      blocks.push({ kind: "heading", text: line.slice(0, -1) });
      continue;
    }

    // Only at the start of a block. Mid-paragraph the label is part of a sentence already in
    // flight, and lifting it out would reorder what the author wrote.
    const labelled = paragraph.length === 0 ? LABELLED.exec(line) : null;
    if (labelled) {
      blocks.push({ kind: "labelled", label: labelled[1].trim(), text: labelled[2].trim() });
      continue;
    }

    paragraph.push(line);
  }

  endParagraph();
  endList();

  return blocks;
}

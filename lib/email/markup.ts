import { fromMarkdown } from "mdast-util-from-markdown";
import type { BlockContent, DefinitionContent, List, Nodes, PhrasingContent, RootContent } from "mdast";

/**
 * The approved verdict payload, rendered as an email body.
 *
 * The payload is markdown that `buildAgentDraftedPayload` wrote, and it is immutable and
 * hash-bound: a reviewer approved those exact bytes, so this only decides how they are shown.
 *
 * Safety here is structural rather than a sanitizer pass. The payload carries agent-authored
 * prose, which can echo prompt-injection content off an untrusted target, including a working
 * `<img src=x onerror=alert(1)>` in a sentence rather than a code fence. mdast represents raw
 * markup as `html` nodes carrying their source text, and this renderer emits those as escaped
 * text, so there is no path from agent text to live markup. That is the reason not to reach for a
 * markdown library that passes HTML through, or for `rehype-raw` plus a sanitizer.
 *
 * Every byte out is a pure function of the bytes in. Resend holds an idempotency key for 24 hours
 * and refuses a reuse that carries a different body, so a timestamp or a counter anywhere in here
 * would turn a safe retry into a mismatch that needs a human.
 */

/** Inline styles only: no mail client applies a stylesheet, and none of them support oklch(). */
const C = {
  ink: "#0d0d12",
  body: "#33333d",
  muted: "#6b6b7a",
  rule: "#e4e4ec",
  panel: "#f6f6fa",
  brand: "#5b4cf5",
  page: "#eeeef4",
  card: "#ffffff",
} as const;

/** The severity ramp, read off the phase palette in globals.css and converted to hex. */
const SEVERITY: Record<string, { fg: string; bg: string }> = {
  critical: { fg: "#7f1d1d", bg: "#fee2e2" },
  high: { fg: "#9a3412", bg: "#ffedd5" },
  medium: { fg: "#854d0e", bg: "#fef3c7" },
  low: { fg: "#155e75", bg: "#cffafe" },
  info: { fg: "#3730a3", bg: "#e0e7ff" },
};

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Inline content as escaped text.
 *
 * `html` is the important case and is handled the same way as `text`: its raw source is escaped,
 * so `<img src=x onerror=alert(1)>` reaches the reader as characters. Emphasis and code spans keep
 * their own tags because this renderer wrote them; a link keeps its text but not its href, since
 * an agent-authored URL in a reporter's inbox is a phishing surface we gain nothing by offering.
 */
function inline(nodes: PhrasingContent[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "html":
          return escapeHtml(node.value);
        case "inlineCode":
          return `<code style="font-family:${MONO};font-size:13px;background:${C.panel};padding:1px 4px;border-radius:3px">${escapeHtml(node.value)}</code>`;
        case "strong":
          return `<strong>${inline(node.children)}</strong>`;
        case "emphasis":
          return `<em>${inline(node.children)}</em>`;
        case "delete":
          return `<s>${inline(node.children)}</s>`;
        case "break":
          return "<br>";
        case "link":
        case "linkReference":
          return inline(node.children as PhrasingContent[]);
        case "image":
        case "imageReference":
          // Never an <img>: a remote src in an email is a read receipt for whoever hosts it.
          return escapeHtml(node.alt ?? "");
        default:
          return "value" in node && typeof node.value === "string" ? escapeHtml(node.value) : "";
      }
    })
    .join("");
}

const P = `margin:0 0 14px;font-size:15px;line-height:1.6;color:${C.body}`;

/** One severity chip, or nothing when the heading did not name a severity. */
function chip(severity: string): string {
  const tone = SEVERITY[severity.toLowerCase()];
  if (!tone) return "";
  return `<span style="display:inline-block;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${tone.fg};background:${tone.bg};padding:3px 8px;border-radius:999px;margin-bottom:8px">${escapeHtml(severity)}</span><br>`;
}

/**
 * `### 1. Reflected XSS via product search 'q' parameter (HIGH)`.
 *
 * `renderFinding` in publish-verdict.ts writes the severity in parentheses at the end, so this
 * lifts it back out to draw a chip. A heading that does not match keeps its text whole rather than
 * losing the tail, because this is a display nicety and the payload is the source of truth.
 */
const FINDING_HEADING = /^(.*?)\s*\((CRITICAL|HIGH|MEDIUM|LOW|INFO)\)\s*$/i;

function block(node: RootContent): string {
  switch (node.type) {
    case "heading": {
      const text = inline(node.children);
      if (node.depth >= 3) {
        const match = FINDING_HEADING.exec(text);
        const title = match ? match[1] : text;
        return `<tr><td style="padding:18px 0 0">${match ? chip(match[2]) : ""}<div style="font-size:16px;font-weight:600;color:${C.ink};line-height:1.4">${title}</div></td></tr>`;
      }
      // ## Summary / ## Findings / ## Target image: section rules, not shouting.
      return `<tr><td style="padding:24px 0 10px;border-top:1px solid ${C.rule}"><div style="font-size:12px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:${C.muted}">${text}</div></td></tr>`;
    }
    case "paragraph":
      return `<tr><td><p style="${P}">${inline(node.children)}</p></td></tr>`;
    case "list":
      return `<tr><td>${listMarkup(node)}</td></tr>`;
    case "code":
      return `<tr><td><pre style="margin:0 0 14px;padding:12px 14px;background:${C.panel};border-radius:6px;font-family:${MONO};font-size:13px;line-height:1.5;color:${C.ink};white-space:pre-wrap;word-break:break-word">${escapeHtml(node.value)}</pre></td></tr>`;
    case "blockquote":
      return `<tr><td><div style="margin:0 0 14px;padding-left:12px;border-left:3px solid ${C.rule}">${node.children.map(block).join("")}</div></td></tr>`;
    case "thematicBreak":
      return `<tr><td style="padding:6px 0"><hr style="border:0;border-top:1px solid ${C.rule};margin:0"></td></tr>`;
    case "html":
      // A block of raw markup, shown as the characters the agent wrote.
      return `<tr><td><p style="${P}">${escapeHtml(node.value)}</p></td></tr>`;
    default:
      return "";
  }
}

/**
 * A list, and everything nested in it.
 *
 * Separate from `block` because a list inside a list item cannot be wrapped in the table row
 * `block` puts round everything at the top level. It recurses on purpose: the agent writes
 * reproduction steps as a numbered list with the exact URLs and console commands indented under
 * a step as a nested list, and those are the part of the finding a reader actually needs.
 */
function listMarkup(node: List, depth = 0): string {
  const tag = node.ordered ? "ol" : "ul";
  const items = node.children
    .map(
      (item) =>
        `<li style="margin:0 0 6px;font-size:15px;line-height:1.6;color:${C.body}">${item.children
          .map((child) => listItemChild(child, depth))
          .join(" ")}</li>`,
    )
    .join("");
  const spacing = depth === 0 ? "margin:0 0 14px" : "margin:6px 0 0";
  return `<${tag} style="${spacing};padding-left:22px">${items}</${tag}>`;
}

/**
 * One child of a list item. A nested list, a code block and a quote each keep their own markup
 * here, because flattening them to inline text is what silently dropped a nested list's items: a
 * list's children are list items, not phrasing content, so inline() had nothing it could render.
 */
function listItemChild(child: BlockContent | DefinitionContent, depth: number): string {
  switch (child.type) {
    case "paragraph":
      return inline(child.children);
    case "list":
      return listMarkup(child, depth + 1);
    case "code":
      return `<pre style="margin:6px 0 0;padding:10px 12px;background:${C.panel};border-radius:6px;font-family:${MONO};font-size:13px;line-height:1.5;color:${C.ink};white-space:pre-wrap;word-break:break-word">${escapeHtml(child.value)}</pre>`;
    case "html":
      return escapeHtml(child.value);
    default:
      return blockText(child);
  }
}

/** Fallback for a node inside a list item that is not one of the kinds above. */
function blockText(node: Nodes): string {
  if ("children" in node && Array.isArray(node.children)) {
    return inline(node.children as PhrasingContent[]);
  }
  return "value" in node && typeof node.value === "string" ? escapeHtml(node.value) : "";
}

/**
 * The payload's body rows.
 *
 * A payload with no headings at all still renders: two other drivers write plain prose
 * (lib/analysis/stub-driver.ts, scripts/seed-reports.ts) and they must degrade to paragraphs
 * rather than throw.
 */
export function renderPayloadRows(payload: string, skipOutcomeHeading = false): string {
  const nodes = fromMarkdown(payload).children;
  return nodes
    .filter((node) => !(skipOutcomeHeading && isOutcomeHeading(node)))
    .map(block)
    .join("");
}

/** `## Outcome: ANALYSIS_ONLY`, which the band above the body already says in plainer words. */
function isOutcomeHeading(node: RootContent): boolean {
  return (
    node.type === "heading" &&
    node.children.length === 1 &&
    node.children[0].type === "text" &&
    /^Outcome:\s*[A-Z_]+$/.test(node.children[0].value.trim())
  );
}

/** What the outcome band says, and the colour it says it in. */
const OUTCOME: Record<string, { label: string; fg: string; bg: string }> = {
  REPRODUCED: { label: "Reproduced", fg: "#7f1d1d", bg: "#fee2e2" },
  NOT_REPRODUCED: { label: "Not reproduced", fg: "#14532d", bg: "#dcfce7" },
  ANALYSIS_ONLY: { label: "Analysis only", fg: "#3730a3", bg: "#e0e7ff" },
};

/**
 * Agent Bounty, in the header, the same for every outcome.
 *
 * The outcome is already carried by the band's own words and colour, so this is decoration. That
 * matters because most clients block images by default: nothing here may be the only thing
 * saying what happened.
 */
const MASCOT = "scanning";

/**
 * `## Outcome: REPRODUCED` is the first line every agent-drafted payload carries.
 *
 * Read rather than passed in, so the band can never disagree with the approved bytes. A payload
 * without the line, which the stub driver and the seed script both write, simply gets no band.
 */
export function outcomeOf(payload: string): keyof typeof OUTCOME | null {
  const match = /^##\s*Outcome:\s*([A-Z_]+)\s*$/m.exec(payload);
  const found = match?.[1];
  return found && found in OUTCOME ? (found as keyof typeof OUTCOME) : null;
}

/**
 * Wrap the payload in the BountyDesk shell.
 *
 * Table-based and inline-styled because that is what mail clients render predictably. The mascot
 * is a static PNG at a fixed URL: the app's own artwork is CSS-animated SVG with JS-namespaced
 * ids, none of which survives an inbox. `assetOrigin` is passed in rather than read from the
 * environment so this stays a pure function, and so the worker needs no new configuration.
 *
 * Images are blocked by default in most clients, so nothing here may carry meaning alone: the
 * outcome is a coloured band with its own words, and the mascot is decoration beside a wordmark.
 */
export function renderVerdictEmail(
  payload: string,
  verdictId: string,
  assetOrigin: string,
): string {
  // The delivery marker is the one piece of the payload that must stay real markup: it is what an
  // audit counts to prove a verdict was sent once. Everything else here escapes html nodes, which
  // would turn it into a visible "<!-- bountydesk-delivery:... -->" in the reader's message, so it
  // is lifted out before rendering and put back raw. Exactly once, checked, because a second copy
  // would break the count and a missing one would break the audit.
  const marker = `<!-- bountydesk-delivery:${verdictId} -->`;
  const parts = payload.split(marker);
  if (parts.length !== 2) {
    throw new Error(`delivery marker for ${verdictId} did not appear exactly once in the payload`);
  }
  const body = parts.join("");

  const outcome = outcomeOf(payload);
  const tone = outcome ? OUTCOME[outcome] : null;

  const band = tone
    ? `<tr><td style="padding:0 0 4px"><span style="display:inline-block;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${tone.fg};background:${tone.bg};padding:6px 12px;border-radius:999px">${tone.label}</span></td></tr>`
    : "";

  const mascot = `<img src="${assetOrigin}/email/${MASCOT}.png" width="48" height="48" alt="" style="display:block;border:0">`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>BountyDesk</title></head>
<body style="margin:0;padding:0;background:${C.page};font-family:${FONT};-webkit-font-smoothing:antialiased">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background:${C.card};border-radius:12px;border:1px solid ${C.rule}">

<tr><td style="padding:20px 28px;border-bottom:1px solid ${C.rule}">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="padding-right:12px">${mascot}</td>
    <td>
      <div style="font-size:16px;font-weight:600;color:${C.ink};letter-spacing:-.01em">BountyDesk</div>
      <div style="font-size:13px;color:${C.muted}">A verdict on your report</div>
    </td>
  </tr></table>
</td></tr>

<tr><td style="padding:22px 28px 4px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${band}
    ${renderPayloadRows(body, tone !== null)}
  </table>
</td></tr>

<tr><td style="padding:16px 28px 22px;border-top:1px solid ${C.rule}">
  <p style="margin:0;font-size:13px;line-height:1.6;color:${C.muted}">
    Reply to this email to respond. A human reviewed and approved this verdict before it was sent.
  </p>
</td></tr>

</table>
</td></tr></table>
${marker}
</body></html>`;
}

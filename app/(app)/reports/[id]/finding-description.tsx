import { describeFinding } from "@/lib/findings/format";
import { cn } from "@/lib/utils";

/**
 * A finding's description, laid out as it was written.
 *
 * The agent's prose carries structure (a label, a numbered run of reproduction steps, then what
 * it observed) that a single pre-wrapped block flattens into a paragraph nobody reads. The
 * blocks come from lib/findings/format.ts, which only recognises what is already in the text.
 *
 * Every block renders as text. Nothing is passed through a markdown renderer and nothing becomes
 * HTML: the agent may have read prompt-injection content off an untrusted target, so a heading
 * here is a heading because the text ended in a colon, not because the text asked to be one.
 */
export function FindingDescription({
  description,
  className,
}: {
  description: string;
  className?: string;
}) {
  const blocks = describeFinding(description);

  if (blocks.length === 0) return null;

  return (
    <div className={cn("flex min-w-0 flex-col gap-2.5", className)}>
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          return (
            <h4
              key={index}
              className="text-meta font-medium tracking-wide text-foreground uppercase"
            >
              {block.text}
            </h4>
          );
        }

        if (block.kind === "steps" || block.kind === "bullets") {
          const ordered = block.kind === "steps";
          const List = ordered ? "ol" : "ul";
          return (
            // Numbered by the list, not by the text: the markers were stripped, so a run that
            // started at "2)" because the agent miscounted still reads in order. Bullets get a
            // dot instead, because they are not an order to follow.
            <List key={index} className="flex flex-col gap-1.5 pl-1">
              {block.items.map((item, item_index) => (
                <li key={item_index} className="flex gap-2.5">
                  <span
                    aria-hidden={ordered ? undefined : "true"}
                    className={cn(
                      "mt-0.5 shrink-0 text-meta text-muted-foreground",
                      ordered ? "w-5 tabular-nums" : "w-2",
                    )}
                  >
                    {ordered ? `${item_index + 1}.` : "•"}
                  </span>
                  {/* Prose, wrapped at spaces. This used to be monospace with break-all, which
                      is right for a bare request line and wrong for the sentences the agent
                      actually writes: it broke words mid-token ("insta nce"). A genuine request
                      line belongs in a fenced block, which is the branch below. */}
                  <span className="min-w-0 flex-1 break-words text-body leading-relaxed text-foreground">
                    {item}
                  </span>
                </li>
              ))}
            </List>
          );
        }

        if (block.kind === "code") {
          return (
            // The one place monospace belongs, and the one place break-all is right: a URL with
            // a payload in it genuinely has no spaces to break at.
            <pre
              key={index}
              className="min-w-0 overflow-x-auto rounded-md bg-muted/50 px-3 py-2 font-mono text-meta wrap-anywhere whitespace-pre-wrap text-foreground"
            >
              {block.text}
            </pre>
          );
        }

        if (block.kind === "labelled") {
          return (
            <p key={index} className="break-words text-body leading-relaxed text-foreground">
              {/* The lead-in the agent writes constantly ("Impact: ..."). Giving it weight is
                  what stops it disappearing into the middle of the paragraph. */}
              <span className="font-medium text-foreground">{block.label}: </span>
              {block.text}
            </p>
          );
        }

        return (
          <p key={index} className="break-words text-body leading-relaxed text-foreground">
            {block.text}
          </p>
        );
      })}
    </div>
  );
}

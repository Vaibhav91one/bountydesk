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

        if (block.kind === "steps") {
          return (
            // Numbered by the list, not by the text: the markers were stripped, so a run that
            // started at "2)" because the agent miscounted still reads in order.
            <ol key={index} className="flex flex-col gap-1.5 pl-1">
              {block.items.map((item, step) => (
                <li key={step} className="flex gap-2.5">
                  <span className="mt-0.5 w-5 shrink-0 text-meta tabular-nums text-muted-foreground">
                    {step + 1}.
                  </span>
                  {/* break-all rather than break-words: a step is usually a request line, and a
                      URL with a payload in it has no spaces to break at. */}
                  <span className="min-w-0 flex-1 font-mono text-meta break-all text-foreground">
                    {item}
                  </span>
                </li>
              ))}
            </ol>
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

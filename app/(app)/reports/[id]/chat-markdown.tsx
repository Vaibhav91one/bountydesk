"use client";

import ReactMarkdown from "react-markdown";

/**
 * An agent chat reply rendered as markdown: headings, bullet and numbered lists, bold, links and
 * code. There is no rehype-raw and no HTML pass-through, so any angle-bracket content in the
 * model's output, which can echo text off an untrusted target, renders as literal characters
 * rather than live HTML. Images are dropped so a reply can't beacon out through a remote src.
 */
export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="text-body leading-relaxed text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        disallowedElements={["img"]}
        unwrapDisallowed
        components={{
          h1: (props) => <h3 className="mt-3 mb-1 text-body font-semibold" {...props} />,
          h2: (props) => <h3 className="mt-3 mb-1 text-body font-semibold" {...props} />,
          h3: (props) => <h4 className="mt-2 mb-1 text-body font-semibold" {...props} />,
          p: (props) => <p className="my-1.5 whitespace-pre-wrap" {...props} />,
          ul: (props) => <ul className="my-1.5 list-disc space-y-0.5 pl-5" {...props} />,
          ol: (props) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5" {...props} />,
          strong: (props) => <strong className="font-semibold" {...props} />,
          code: (props) => (
            <code className="rounded bg-muted px-1 py-0.5 text-[0.9em]" {...props} />
          ),
          pre: (props) => (
            <pre className="my-1.5 overflow-x-auto rounded bg-muted p-2 text-[0.9em]" {...props} />
          ),
          a: ({ href, ...props }) => (
            <a
              href={href}
              rel="noreferrer noopener"
              target="_blank"
              className="underline underline-offset-2"
              {...props}
            />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

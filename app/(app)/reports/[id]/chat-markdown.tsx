"use client";

import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";

/**
 * An agent chat reply rendered as markdown: headings, bullet and numbered lists, bold, links and
 * code. There is no rehype-raw and no HTML pass-through, so any angle-bracket content in the
 * model's output, which can echo text off an untrusted target, renders as literal characters
 * rather than live HTML. Images are dropped so a reply can't beacon out through a remote src.
 *
 * Each renderer takes only the children it needs and never spreads react-markdown's props: that
 * props bag carries a `node` object which, spread onto a DOM element, leaks a `node="[object
 * Object]"` attribute.
 */
export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="text-body leading-relaxed text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        disallowedElements={["img"]}
        unwrapDisallowed
        components={{
          h1: ({ children }) => <h3 className="mt-3 mb-1 text-body font-semibold">{children}</h3>,
          h2: ({ children }) => <h3 className="mt-3 mb-1 text-body font-semibold">{children}</h3>,
          h3: ({ children }) => <h4 className="mt-2 mb-1 text-body font-semibold">{children}</h4>,
          p: ({ children }) => <p className="my-1.5 whitespace-pre-wrap">{children}</p>,
          ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          code: ({ children }) => (
            <code className="rounded bg-muted px-1 py-0.5 text-[0.9em]">{children}</code>
          ),
          pre: ({ children }) => (
            <pre className="my-1.5 overflow-x-auto rounded bg-muted p-2 text-[0.9em]">{children}</pre>
          ),
          a: ({ href, children }: { href?: string; children?: ReactNode }) => (
            <a
              href={href}
              rel="noreferrer noopener"
              target="_blank"
              className="underline underline-offset-2"
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

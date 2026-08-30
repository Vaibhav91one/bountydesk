"use client";

import { useState } from "react";
import { CaretDown } from "@phosphor-icons/react/ssr";

import { cn } from "@/lib/utils";

/**
 * The questions a security reader arrives with, answered the short way first.
 *
 * A blunt "No" in an FAQ costs nothing and buys the rest of the page. The same admission in a
 * hero paragraph reads as flinching, which is why the unbuilt half of this product is stated
 * here and labelled on the one panel it applies to, rather than hedged throughout.
 *
 * Answers come from docs/decisions.md rather than being written fresh, so the front door and
 * the design record cannot drift apart.
 */
const QUESTIONS: { q: string; a: string }[] = [
  {
    q: "Does reproduction run today?",
    a: "Yes, for the one pinned target. A TrueForge agent investigates the report in an isolated sandbox and drafts its own outcome, summary and findings. What still won't change: a report with no authorized target, or one whose repository grant has since been revoked, cannot come back reproduced or not reproduced, whatever the agent concluded. That report stays an analysis packet, and a person decides.",
  },
  {
    q: "How would you know a bug is real?",
    a: "The agent's own investigation is the source: it works the report against its authorized target inside a sandbox, using scope-guard and its skills, and reaches its own conclusion. Two things keep that conclusion honest. A person has to approve the exact drafted text before anything reaches the reporter, so nothing ships unseen. And the server re-checks authorization before a reproduced or not-reproduced claim becomes a verdict: a report with no bound target, or one whose grant has been revoked, is refused regardless of what the agent asserts.",
  },
  {
    q: "What exactly am I approving?",
    a: "The precise bytes of the outbound comment, bound to a content hash. The delivery worker reads the immutable verdict and refuses any payload whose hash differs from the one you approved, so an approval cannot be reused for different words. Approving does not close the issue.",
  },
  {
    q: "How is scope enforced?",
    a: "At the capability boundary, not by the agent choosing to behave. Clone, deploy and egress each take the target from a server-held profile, never from a string the model produced. Issue text, attachments and model output can never create a profile, so a report without one is triaged and goes no further.",
  },
  {
    q: "What does the GitHub App ask for?",
    a: "Metadata read, and Issues read and write. Nothing that can write code, open pull requests or change repository settings. Signing in says who you are; installing the App is what grants access to a repository, and the two are deliberately separate.",
  },
  {
    q: "Do I need GitHub at all?",
    a: "Not for intake. Email and file upload are independent channels that need no GitHub connection to create and triage a report. Neither is wired yet: outbound needs a verified recipient and a transport receipt before a delivery may be recorded, so a report from those channels must never reach delivered.",
  },
];

export function Faq() {
  const [open, setOpen] = useState<string | null>(QUESTIONS[0].q);

  return (
    <ul className="flex flex-col">
      {QUESTIONS.map((item) => {
        const isOpen = open === item.q;
        return (
          <li key={item.q} className="border-b border-border/50 first:border-t">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : item.q)}
              className="flex w-full cursor-pointer items-center gap-4 py-5 text-left"
            >
              <span className="flex-1 text-heading text-foreground">{item.q}</span>
              <CaretDown
                aria-hidden="true"
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform duration-300",
                  isOpen && "rotate-180",
                )}
              />
            </button>

            {/* The house disclosure: grid rows animating between 1fr and 0fr, so it opens to
                whatever the answer measures without anybody measuring it. inert as well as
                collapsed, or a keyboard lands inside an answer nobody can see. */}
            <div
              inert={!isOpen}
              aria-hidden={!isOpen}
              className="grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]"
              style={{ gridTemplateRows: isOpen ? "1fr" : "0fr", opacity: isOpen ? 1 : 0 }}
            >
              <div className="overflow-hidden">
                <p className="max-w-2xl pb-5 text-body text-muted-foreground">{item.a}</p>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

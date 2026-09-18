"use client";

import type { RefObject } from "react";
import {
  ArrowUp,
  ListChecks,
  MagnifyingGlass,
  PencilSimple,
  ShieldCheck,
  Wrench,
} from "@phosphor-icons/react/ssr";

import { RollingIcon } from "@/components/rolling-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The premade prompts above the composer. They stay fixed with the bar because
 * the message list above scrolls, not this footer.
 */
export const QUICK_PROMPTS = [
  { label: "Summarize issue", icon: ListChecks, prompt: "Summarize the reproduced issue, including steps and impact." },
  { label: "Review steps", icon: MagnifyingGlass, prompt: "Review the reproduction steps and point out any missing details for triage." },
  { label: "Suggest remediation", icon: Wrench, prompt: "Suggest remediation and secure coding guidance for this issue." },
  { label: "Verify a fix", icon: ShieldCheck, prompt: "Suggest verification steps for a reviewer to confirm a fix." },
  { label: "Improve report", icon: PencilSimple, prompt: "Suggest concise edits to the report text for clarity." },
] as const;

/**
 * Bottom-only composer for the advisory chat. Blank message surface lives
 * above it; this footer never scrolls away.
 *
 * Deliberately narrow against the beautiful-ui PromptBar it borrows its shape
 * from: no attach, @ sources, / commands, model picker, or dictation, because
 * none of those have a backend here. Rounded pill always.
 */
export function PromptBar({
  draft,
  onDraftChange,
  onSend,
  onQuickPrompt,
  sending,
  mode,
  inputRef,
}: {
  draft: string;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onQuickPrompt: (prompt: string) => void;
  sending: boolean;
  mode: "loading" | "ready" | "disabled" | "error";
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const canSend = draft.trim().length > 0 && !sending && mode === "ready";

  return (
    <div className="flex flex-col">
      <div className="no-scrollbar mb-2 flex gap-2 overflow-x-auto" role="group" aria-label="Suggested prompts">
        {QUICK_PROMPTS.map(({ label, icon: Icon, prompt }) => (
          <Button
            key={label}
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onQuickPrompt(prompt)}
            disabled={sending || mode !== "ready"}
            className="shrink-0"
          >
            <RollingIcon icon={Icon} className="size-3.5" /> {label}
          </Button>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
        onClick={() => inputRef.current?.focus()}
        className="flex cursor-text items-center gap-2 rounded-full border border-border/50 bg-background px-3 py-1.5 transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20 motion-reduce:transition-none"
      >
        <Input
          ref={inputRef}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="Ask about this verdict"
          aria-label="Message to Agent Bounty"
          disabled={sending || mode !== "ready"}
          className="h-9 min-w-0 flex-1 border-0 bg-transparent px-0 text-body shadow-none focus-visible:border-0 focus-visible:ring-0"
        />
        <Button
          type="submit"
          size="icon-xs"
          variant="default"
          aria-label="Send advisory message"
          disabled={!canSend}
          loading={sending}
          className="size-8 rounded-full"
        >
          {sending ? null : <ArrowUp weight="bold" className="size-4" />}
        </Button>
      </form>
      <p className="mt-1.5 px-2 text-meta text-muted-foreground/70">
        Plain text only. Approval and denial are separate.
      </p>
    </div>
  );
}

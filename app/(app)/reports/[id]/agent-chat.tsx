"use client";

import { useRef, useState } from "react";
import { ArrowUp } from "@phosphor-icons/react/ssr";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { LoaderGrid, ShimmerLabel, StreamingText } from "./agent-trace";

export type ChatTurn = { id: number; from: "reviewer" | "agent"; text: string; source?: string };

/**
 * The conversation you have instead of approving.
 *
 * Ported from a chat composer: a header of context tabs, a right-aligned bubble for what you
 * said, labelled sections for what came back, and a composer whose send button lights only
 * once there is something to send.
 *
 * What you type here is not decoration. It becomes the reason on the denial, which is the one
 * reviewer-to-system message this product actually records, so the last thing you wrote is
 * what a denial carries.
 *
 * The replies are assembled from this report's record. Nothing is sent to the harness: there
 * is no channel for it, and the line under the composer says so rather than leaving somebody
 * to assume otherwise.
 */
export function AgentChat({
  turns,
  thinking,
  topics,
  topic,
  onTopic,
  onSend,
  onDeny,
  denying,
  canDeny,
}: {
  turns: ChatTurn[];
  thinking: boolean;
  topics: string[];
  topic: string;
  onTopic: (next: string) => void;
  onSend: (text: string) => void;
  onDeny: () => void;
  denying: boolean;
  canDeny: boolean;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const canSend = draft.trim().length > 0 && !thinking;

  function send() {
    if (!canSend) return;
    onSend(draft.trim());
    setDraft("");
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border/50 bg-card">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/50 p-1.5">
        {topics.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={topic === item}
            onClick={() => onTopic(item)}
            className={cn(
              "rounded-md px-2 py-1 text-meta text-foreground transition-opacity duration-100",
              topic === item ? "bg-muted" : "opacity-50 hover:opacity-80",
            )}
          >
            {item}
          </button>
        ))}
      </div>

      <div className="flex max-h-64 min-h-32 flex-col gap-3 overflow-y-auto px-3 py-3">
        {turns.length === 0 && !thinking ? (
          <p className="text-meta text-muted-foreground">
            Say what is wrong with this comment. What you write becomes the reason on the denial.
          </p>
        ) : null}

        {turns.map((turn) =>
          turn.from === "reviewer" ? (
            <div key={turn.id} className="flex justify-end pl-10">
              <p className="rounded-xl bg-muted px-3 py-1.5 text-body text-foreground">
                {turn.text}
              </p>
            </div>
          ) : (
            <div key={turn.id} className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
                <span className="text-foreground">Agent Bounty</span>
                {turn.source ? <span>· {turn.source}</span> : null}
              </span>
              <StreamingText text={turn.text} />
            </div>
          ),
        )}

        {thinking ? (
          <span className="flex items-center gap-2.5">
            <LoaderGrid />
            <ShimmerLabel>Reading the record</ShimmerLabel>
          </span>
        ) : null}
      </div>

      <div className="mt-auto shrink-0 p-1.5">
        <div
          role="presentation"
          onClick={() => inputRef.current?.focus()}
          className="flex cursor-text flex-col gap-2 rounded-md border border-border/50 bg-background p-2.5 focus-within:border-ring"
        >
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                send();
              }
            }}
            placeholder="What is wrong with this comment?"
            aria-label="Message to Agent Bounty"
            className="bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-meta text-muted-foreground/70">
              Composed from this report&rsquo;s record. Not sent to the harness.
            </span>
            <button
              type="button"
              aria-label="Send"
              disabled={!canSend}
              onClick={send}
              className={cn(
                "flex size-7 items-center justify-center rounded-md transition-colors duration-200 enabled:active:scale-[0.96]",
                canSend
                  ? "bg-foreground text-background"
                  : "bg-border text-muted-foreground",
              )}
            >
              <ArrowUp weight="bold" className="size-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border/50 px-4 py-3">
        <span className="text-meta text-muted-foreground">
          {canDeny ? "Denies with your last message as the reason." : "Write a reason to deny."}
        </span>
        <Button
          size="sm"
          variant="destructive"
          onClick={onDeny}
          loading={denying}
          disabled={!canDeny}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}

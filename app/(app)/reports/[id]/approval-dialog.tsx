"use client";

import { useState } from "react";
import { PaperPlaneRight, Signature } from "@phosphor-icons/react/ssr";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import { AgentTrace, LoaderGrid, ShimmerLabel, StreamingText, type TraceRow } from "./agent-trace";
import { SignVerdict } from "./sign-verdict";

type Message = { id: number; from: "reviewer" | "agent"; text: string };

/**
 * Everything a reviewer needs before signing, in one place.
 *
 * The gate itself has not moved: SignVerdict below still calls the same guarded action, which
 * re-reads and locks its own rows and refuses a payload whose hash has changed. Nothing in
 * this dialog can approve anything, and nothing in the conversation reaches it.
 */
export function ApprovalDialog({
  reportId,
  verdictId,
  contentHash,
  payload,
  outcomeLabel,
  summary,
  targetName,
  reproductionRan,
  events,
}: {
  reportId: string;
  verdictId: string;
  contentHash: string;
  payload: string;
  outcomeLabel: string;
  summary: string;
  targetName: string | null;
  reproductionRan: boolean;
  events: TraceRow[];
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);

  /**
   * What the agent answers with.
   *
   * Assembled from this report's own record, never invented. A canned line claiming the bug
   * was reproduced would be the model narrating a verdict, which is the one thing it must
   * never do; so every sentence here restates something already on this screen, and when no
   * reproduction ran it says exactly that.
   */
  function reply(): string {
    const target = targetName ? `the pinned target ${targetName}` : "no bound target";
    const evidence = reproductionRan
      ? "The oracle observed this run's canary outside the sandbox, and that is what decided the outcome."
      : "No sandbox was provisioned and no canary was seeded, so nothing was reproduced and the outcome is analysis only.";

    return `This report is bound to ${target}. ${evidence} The verdict on record reads ${outcomeLabel.toLowerCase()}: ${summary} Approving binds the exact comment shown here and its hash; nothing is posted until you do.`;
  }

  function send(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || thinking) return;

    setMessages((current) => [
      ...current,
      { id: current.length, from: "reviewer", text },
    ]);
    setDraft("");
    setThinking(true);

    window.setTimeout(() => {
      setMessages((current) => [...current, { id: current.length, from: "agent", text: reply() }]);
      setThinking(false);
    }, 900);
  }

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            size="sm"
            className="relative animate-approval-halo bg-phase-approval text-background hover:bg-phase-approval/85 motion-reduce:animate-none"
          >
            <Signature weight="fill" className="size-4" /> Approval needed
          </Button>
        }
      />

      <DialogContent className="max-h-[85vh] gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border/50 p-5">
          <DialogTitle>Sign the verdict</DialogTitle>
          <DialogDescription>
            The run has stopped here. Nothing is posted until you approve the exact words below.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6 p-5">
          <AgentTrace rows={events} />

          <div className="flex flex-col gap-2">
            <span className="text-meta text-muted-foreground">The exact comment</span>
            {/* Plain text, never rendered. These are the bytes that would be posted, and a
                rendering of them is not them. */}
            <pre className="max-h-64 overflow-auto rounded-md border border-border/50 bg-background p-4 text-body whitespace-pre-wrap text-foreground">
              {payload}
            </pre>
            <p className="font-mono text-meta break-all text-muted-foreground">
              <span className="text-muted-foreground/70">sha256 </span>
              {contentHash}
            </p>
          </div>

          <div className="flex flex-col gap-3 rounded-xl border border-border/50 bg-background p-4">
            <span className="text-meta text-muted-foreground">Ask Agent Bounty</span>

            {messages.length === 0 && !thinking ? (
              <p className="text-meta text-muted-foreground">
                Ask about the target, the evidence, or what approving binds.
              </p>
            ) : null}

            {messages.map((message) =>
              message.from === "reviewer" ? (
                <p
                  key={message.id}
                  className="self-end rounded-md bg-muted px-3 py-2 text-body text-foreground"
                >
                  {message.text}
                </p>
              ) : (
                <StreamingText key={message.id} text={message.text} />
              ),
            )}

            {thinking ? (
              <span className="flex items-center gap-2.5">
                <LoaderGrid />
                <ShimmerLabel>Reading the record</ShimmerLabel>
              </span>
            ) : null}

            <form onSubmit={send} className="flex items-center gap-2">
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Ask about this report"
                aria-label="Ask Agent Bounty about this report"
                className="h-10 border-border/50 text-body"
              />
              <Button type="submit" size="icon-sm" variant="outline" aria-label="Send">
                <PaperPlaneRight className="size-4" />
              </Button>
            </form>

            {/* Said once, quietly. The answers are assembled from this report's own record and
                the question is not sent anywhere: there is no reviewer-to-agent channel yet,
                and somebody reading this screen without that context should not have to guess. */}
            <p className="text-meta text-muted-foreground/70">
              Answers are composed from this report&rsquo;s record. Questions are not sent to the
              harness; that channel is not built.
            </p>
          </div>

          <div className="border-t border-border/50 pt-5">
            <SignVerdict
              reportId={reportId}
              verdictId={verdictId}
              contentHash={contentHash}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

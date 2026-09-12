"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, ArrowUp, CircleNotch, Warning } from "@phosphor-icons/react/ssr";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ChatSender = "REVIEWER" | "AGENT" | "SYSTEM";

type ChatMessage = {
  id: string;
  clientRequestId: string;
  sender: ChatSender;
  body: string;
  createdAt: string;
};

type ChatStatus = {
  reportId: string;
  threads: Array<{
    id: string;
    status: "OPEN" | "RUNNING" | "DONE" | "ERROR" | "CANCELLED";
    messages: ChatMessage[];
  }>;
};

type ChatRequest = {
  clientRequestId: string;
  body: string;
};

type ChatResponse = {
  disposition: "CREATED" | "DUPLICATE";
  status: "PENDING" | "DONE";
  responseBody: string | null;
};

export const ADVISORY_LABEL = "Advisory conversation, not approval";
export const QUICK_PROMPTS = [
  "Ask another angle",
  "Ask for missing evidence",
] as const;

export function canSubmitReviewerMessage(
  draft: string,
  sending: boolean,
  mode: "loading" | "ready" | "disabled" | "error",
): boolean {
  return draft.trim().length > 0 && !sending && mode === "ready";
}

/** The response row is bound to the reviewer row by this durable suffix. */
export function responseRequestId(clientRequestId: string): string {
  return `${clientRequestId}:agent`;
}

/** Build the one browser payload. Retrying this object must preserve its request ID and body. */
export function reviewerMessagePayload(request: ChatRequest): ChatRequest {
  return {
    clientRequestId: request.clientRequestId,
    body: request.body,
  };
}

function newRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `reviewer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The advisory conversation could not be reached.";
}

function allMessages(status: ChatStatus | null): ChatMessage[] {
  return status?.threads.flatMap((thread) => thread.messages) ?? [];
}

function latestReviewerMessage(status: ChatStatus | null): ChatMessage | null {
  return (
    allMessages(status)
      .filter((message) => message.sender === "REVIEWER")
      .at(-1) ?? null
  );
}

function failedRequestFromStatus(status: ChatStatus | null): ChatRequest | null {
  for (const thread of status?.threads ?? []) {
    if (thread.status !== "ERROR") continue;
    const reviewerMessage = [...thread.messages]
      .reverse()
      .find(
        (message) =>
          message.sender === "REVIEWER" &&
          !thread.messages.some(
            (response) =>
              response.sender === "AGENT" &&
              response.clientRequestId === responseRequestId(message.clientRequestId),
          ),
      );
    if (reviewerMessage) {
      return { clientRequestId: reviewerMessage.clientRequestId, body: reviewerMessage.body };
    }
  }
  return null;
}

/** A text-only message primitive. React escapes the body, so model output is never HTML. */
export function DurableChatMessage({ message }: { message: ChatMessage }) {
  return (
    <div className={cn("flex flex-col gap-1.5", message.sender === "REVIEWER" && "items-end pl-10")}>
      {message.sender === "AGENT" ? (
        <span className="text-meta text-muted-foreground">
          <span className="text-foreground">Agent Bounty</span>
        </span>
      ) : null}
      <p
        className={cn(
          "whitespace-pre-wrap text-body text-foreground",
          message.sender === "REVIEWER" && "rounded-xl bg-muted px-3 py-1.5",
        )}
      >
        {message.body}
      </p>
    </div>
  );
}

/**
 * The reviewer conversation is advisory. It reads and writes durable rows through the authenticated
 * report routes, while approval and denial remain the separate controls on VerdictCard.
 */
export function AgentChat({
  reportId,
  revision,
  contentHash,
  onReasonChange,
}: {
  reportId: string;
  revision: number;
  contentHash: string;
  onReasonChange: (reason: string | null) => void;
}) {
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [mode, setMode] = useState<"loading" | "ready" | "disabled" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState<ChatRequest | null>(null);
  const [failed, setFailed] = useState<ChatRequest | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch(`/api/reports/${encodeURIComponent(reportId)}/chat/status`, {
        cache: "no-store",
      });
      if (response.status === 404) {
        setMode("disabled");
        setLoadError(null);
        return;
      }
      if (!response.ok) throw new Error(`The advisory conversation returned ${response.status}.`);
      const next = (await response.json()) as ChatStatus;
      setStatus(next);
      onReasonChange(latestReviewerMessage(next)?.body ?? null);
      setMode("ready");
      setLoadError(null);
    } catch (error) {
      setMode("error");
      setLoadError(errorText(error));
    }
  }, [onReasonChange, reportId]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadStatus(), 0);
    const interval = window.setInterval(() => void loadStatus(), 1_500);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [loadStatus]);

  const failedRequest = failed ?? failedRequestFromStatus(status);
  const failedOnServer = Boolean(
    failedRequest &&
      status?.threads.some(
        (thread) =>
          (thread.status === "ERROR" || thread.status === "CANCELLED") &&
          thread.messages.some(
            (message) =>
              message.sender === "REVIEWER" &&
              message.clientRequestId === failedRequest.clientRequestId,
          ),
      ),
  );
  const canSend = canSubmitReviewerMessage(draft, Boolean(sending), mode);
  const messages = allMessages(status);

  async function submit(request: ChatRequest) {
    setSending(request);
    setFailed(null);
    setSendError(null);

    try {
      const response = await fetch(`/api/reports/${encodeURIComponent(reportId)}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reviewerMessagePayload(request)),
      });
      const payload = (await response.json().catch(() => null)) as
        | (ChatResponse & { error?: string })
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `The advisory conversation returned ${response.status}.`);
      }
      setSending(null);
      setFailed(null);
      onReasonChange(request.body);
      await loadStatus();
    } catch (error) {
      setSending(null);
      setFailed(request);
      setSendError(errorText(error));
    }
  }

  function send() {
    const body = draft.trim();
    if (!body || !canSend) return;
    setDraft("");
    void submit({ clientRequestId: newRequestId(), body });
  }

  function sendPrompt(prompt: string) {
    if (sending || mode !== "ready") return;
    void submit({ clientRequestId: newRequestId(), body: prompt });
  }

  if (mode === "disabled") {
    return (
      <section className="rounded-xl border border-border/50 bg-card p-4" aria-label="Reviewer advisory chat">
        <p className="text-body font-medium text-foreground">{ADVISORY_LABEL}</p>
        <p className="mt-1 text-meta text-muted-foreground">
          Reviewer chat is not enabled for this environment. Approval and denial remain available
          in the verdict controls.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col overflow-hidden rounded-xl border border-border/50 bg-card" aria-label="Reviewer advisory chat">
      <div className="flex flex-col gap-1 border-b border-border/50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-body font-medium text-foreground">{ADVISORY_LABEL}</h2>
          <span className="text-meta text-muted-foreground">Revision {revision}</span>
        </div>
        <p className="break-all text-meta text-muted-foreground">Content hash: {contentHash}</p>
        <p className="text-meta text-muted-foreground">
          Ask questions about this exact draft. Nothing here changes the verdict or authorises a
          tool.
        </p>
      </div>

      {mode === "loading" ? (
        <div className="flex items-center gap-2.5 px-4 py-6 text-meta text-muted-foreground" role="status">
          <CircleNotch className="size-4 animate-spin" /> Loading conversation
        </div>
      ) : null}

      {mode === "error" ? (
        <div className="flex flex-col gap-3 p-4" role="alert">
          <p className="flex items-start gap-2 text-body text-destructive">
            <Warning className="mt-0.5 size-4 shrink-0" />
            {loadError ?? "The advisory conversation could not be loaded."}
          </p>
          <Button size="sm" variant="outline" onClick={() => void loadStatus()}>
            <ArrowClockwise className="size-4" /> Retry
          </Button>
        </div>
      ) : null}

      {mode === "ready" ? (
        <>
          <div className="flex max-h-64 min-h-28 flex-col gap-3 overflow-y-auto px-4 py-4">
            {messages.length === 0 ? (
              <p className="text-meta text-muted-foreground">
                Ask a question about the evidence or the exact comment before deciding.
              </p>
            ) : null}
            {messages.map((message) => (
              <DurableChatMessage key={message.id} message={message} />
            ))}
          </div>

          <div className="flex flex-wrap gap-2 border-t border-border/50 px-4 py-3">
            {QUICK_PROMPTS.map((prompt) => (
              <Button
                key={prompt}
                size="xs"
                variant="outline"
                onClick={() => sendPrompt(prompt)}
                disabled={Boolean(sending)}
              >
                {prompt}
              </Button>
            ))}
            <Button
              size="xs"
              variant="outline"
              disabled
              title="Guided re-check is not available yet. It will supersede this verdict and start a new run."
            >
              Ask to re-check
              <span className="text-meta text-muted-foreground">Coming soon</span>
            </Button>
          </div>

          <div className="p-2">
            <div className="flex cursor-text flex-col gap-2 rounded-md border border-border/50 bg-background p-2.5 focus-within:border-ring">
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    send();
                  }
                }}
                placeholder="Ask about this verdict"
                aria-label="Message to Agent Bounty"
                disabled={Boolean(sending)}
                className="bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
              />
              <div className="flex items-center justify-between gap-3">
                <span className="text-meta text-muted-foreground/70">
                  Plain text only. Approval and denial are separate.
                </span>
                <button
                  type="button"
                  aria-label="Send advisory message"
                  disabled={!canSend}
                  onClick={send}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md transition-colors duration-200 enabled:active:scale-[0.96]",
                    canSend ? "bg-foreground text-background" : "bg-border text-muted-foreground",
                  )}
                >
                  {sending ? <CircleNotch className="size-4 animate-spin" /> : <ArrowUp weight="bold" className="size-4" />}
                </button>
              </div>
            </div>
          </div>

          {failedRequest ? (
            <div className="flex items-center justify-between gap-3 border-t border-destructive/30 bg-destructive/5 px-4 py-3" role="alert">
              <span className="text-meta text-destructive">
                {failedOnServer
                  ? "The provider did not complete this advisory turn. Retry the same request."
                  : sendError ?? "The message was not sent."}
              </span>
              <Button size="xs" variant="outline" onClick={() => void submit(failedRequest)}>
                <ArrowClockwise className="size-3" /> Retry
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export type { ChatMessage, ChatStatus, ChatRequest };

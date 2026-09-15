"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, CircleNotch, Warning } from "@phosphor-icons/react/ssr";

import { requestRecheckAction } from "@/app/review/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { LoaderGrid, ShimmerLabel, StreamingText } from "./agent-trace";
import { PromptBar, QUICK_PROMPTS } from "./prompt-bar";

export { QUICK_PROMPTS };

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

export const ADVISORY_LABEL = "Agent Bounty is on this case";

export function canSubmitReviewerMessage(
  draft: string,
  sending: boolean,
  mode: "loading" | "ready" | "disabled" | "error",
): boolean {
  return draft.trim().length > 0 && !sending && mode === "ready";
}

/** Agent rows present in the initial status snapshot are history, not new replies. */
export function newlyObservedAgentIds(
  messages: ChatMessage[],
  seen: ReadonlySet<string>,
): string[] {
  return messages
    .filter((message) => message.sender === "AGENT" && !seen.has(message.id))
    .map((message) => message.id);
}

/** Only an active reviewer near the latest message should be moved by polling. */
export function shouldFollowChat(active: boolean, nearBottom: boolean, ownChange = false): boolean {
  return active && (nearBottom || ownChange);
}

/**
 * History replays as static text. Only an agent row created after this mount
 * (30s grace for server/browser clock skew) earns the word-by-word reveal.
 */
export function isFreshAgentMessage(createdAt: string, mountedAt: number): boolean {
  const time = Date.parse(createdAt);
  return Number.isFinite(time) && time >= mountedAt - 30_000;
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

function pendingReviewerMessage(status: ChatStatus | null): ChatMessage | null {
  for (const thread of status?.threads ?? []) {
    if (thread.status !== "OPEN" && thread.status !== "RUNNING") continue;
    const message = [...thread.messages]
      .reverse()
      .find(
        (candidate) =>
          candidate.sender === "REVIEWER" &&
          !thread.messages.some(
            (response) =>
              response.sender === "AGENT" &&
              response.clientRequestId === responseRequestId(candidate.clientRequestId),
          ),
      );
    if (message) return message;
  }
  return null;
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
  verdictId,
  active,
  onReasonChange,
}: {
  reportId: string;
  verdictId: string;
  revision: number;
  contentHash: string;
  active: boolean;
  onReasonChange: (reason: string | null) => void;
}) {
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [mode, setMode] = useState<"loading" | "ready" | "disabled" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState<ChatRequest | null>(null);
  const [failed, setFailed] = useState<ChatRequest | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [recheckState, setRecheckState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [recheckError, setRecheckError] = useState<string | null>(null);
  const [revealingAgentIds, setRevealingAgentIds] = useState<Set<string>>(new Set());
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const hydratedRef = useRef(false);
  // Set on mount, before the first status fetch resolves. Keyed by report and
  // verdict in the parent, so a new conversation always remounts fresh.
  const mountedAtRef = useRef(0);
  const seenAgentIdsRef = useRef<Set<string>>(new Set());
  const nearBottomRef = useRef(true);
  const ownChangeRef = useRef(false);
  const initialScrollRef = useRef(false);
  const scrollMessages = useCallback((behavior: ScrollBehavior = "smooth") => {
    const list = messagesRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    if (!active || mode !== "ready") return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [active, mode]);

  const requestRecheck = useCallback(async () => {
    if (!window.confirm("Start a fresh investigation? This supersedes the current verdict and requires a new approval.")) return;
    // The guidance is the reviewer's typed question, or a neutral default when they never
    // typed one. The server re-validates everything: this string is a suggestion, never
    // authority over target, tools, or approval.
    const guidance =
      draft.trim() ||
      "The reviewer asked for a fresh look at this report. Investigate it from scratch and draft your own conclusion.";
    setRecheckState("sending");
    setRecheckError(null);
    try {
      const result = await requestRecheckAction(reportId, verdictId, guidance);
      if (!result.ok) throw new Error(result.error ?? "The re-check could not be started.");
      setRecheckState("sent");
    } catch (error) {
      setRecheckState("error");
      setRecheckError(error instanceof Error ? error.message : "The re-check could not be started.");
    }
  }, [draft, reportId, verdictId]);

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
      const nextMessages = allMessages(next);
      if (!hydratedRef.current) {
        hydratedRef.current = true;
        for (const message of nextMessages) {
          if (message.sender === "AGENT") seenAgentIdsRef.current.add(message.id);
        }
      } else {
        const newlyObserved = newlyObservedAgentIds(nextMessages, seenAgentIdsRef.current);
        for (const id of newlyObserved) seenAgentIdsRef.current.add(id);
        // History rows observed late (reopen, verdict switch) stay static. Only rows
        // created after this mount reveal word by word.
        const fresh = newlyObserved.filter((id) => {
          const message = nextMessages.find((candidate) => candidate.id === id);
          return message ? isFreshAgentMessage(message.createdAt, mountedAtRef.current) : false;
        });
        if (fresh.length > 0) {
          setRevealingAgentIds((current) => new Set([...current, ...fresh]));
        }
      }
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
  const pendingMessage = pendingReviewerMessage(status);
  const newestAgentId = [...messages].reverse().find((message) => message.sender === "AGENT")?.id;

  const updateNearBottom = useCallback(() => {
    const list = messagesRef.current;
    if (!list) return;
    nearBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight <= 48;
    if (nearBottomRef.current) setHasNewBelow(false);
  }, []);

  useEffect(() => {
    mountedAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    const list = messagesRef.current;
    if (!list) return;
    updateNearBottom();
    list.addEventListener("scroll", updateNearBottom, { passive: true });
    return () => list.removeEventListener("scroll", updateNearBottom);
  }, [mode, updateNearBottom]);

  useEffect(() => {
    if (mode !== "ready" || !active) return;
    if (!initialScrollRef.current) {
      initialScrollRef.current = true;
      requestAnimationFrame(() => scrollMessages("auto"));
      return;
    }

    const ownChange = ownChangeRef.current;
    // Scrolled up while polling: never yank. Flag it so the reviewer can jump down.
    if (!shouldFollowChat(active, nearBottomRef.current, ownChange)) {
      if (!ownChange) setHasNewBelow(true);
      return;
    }
    setHasNewBelow(false);
    const behavior = ownChange ? "smooth" : "auto";
    ownChangeRef.current = false;
    requestAnimationFrame(() => scrollMessages(behavior));
  }, [active, mode, messages.length, pendingMessage?.clientRequestId, scrollMessages]);

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
      setFailed(null);
      onReasonChange(request.body);
      await loadStatus();
      setSending(null);
    } catch (error) {
      setSending(null);
      ownChangeRef.current = false;
      setFailed(request);
      setSendError(errorText(error));
    }
  }

  function send() {
    const body = draft.trim();
    if (!body || !canSend) return;
    setDraft("");
    ownChangeRef.current = true;
    void submit({ clientRequestId: newRequestId(), body });
  }

  function sendPrompt(prompt: string) {
    if (sending || mode !== "ready") return;
    ownChangeRef.current = true;
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
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/50 bg-card" aria-label="Reviewer advisory chat">

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
          <div
            ref={messagesRef}
            role="log"
            aria-live="polite"
            aria-label="Conversation with Agent Bounty"
            className="min-h-0 flex-1 flex flex-col gap-3 overflow-y-auto px-4 py-4"
          >
            {messages.length === 0 ? (
              <p className="text-meta text-muted-foreground">
                Ask a question about the evidence or the exact comment before deciding.
              </p>
            ) : null}
            {messages.map((message) =>
              message.sender === "AGENT" ? (
                <div key={message.id} className="flex flex-col gap-1.5">
                  <span className="text-meta text-muted-foreground">
                    <span className="text-foreground">Agent Bounty</span>
                  </span>
                  {revealingAgentIds.has(message.id) ? (
                    <StreamingText
                      text={message.body}
                      onDone={() => {
                        setRevealingAgentIds((current) => {
                          if (!current.has(message.id)) return current;
                          const next = new Set(current);
                          next.delete(message.id);
                          return next;
                        });
                        if (nearBottomRef.current && message.id === newestAgentId) scrollMessages();
                      }}
                    />
                  ) : (
                    <p className="whitespace-pre-wrap text-body leading-relaxed text-foreground">
                      {message.body}
                    </p>
                  )}
                </div>
              ) : (
                <DurableChatMessage key={message.id} message={message} />
              ),
            )}
            {pendingMessage ? (
              <div className="flex items-center gap-2.5 py-1" role="status" aria-label="Agent Bounty is thinking">
                <LoaderGrid />
                <ShimmerLabel>Agent Bounty is thinking</ShimmerLabel>
              </div>
            ) : null}
            {hasNewBelow ? (
              <div className="sticky bottom-0 flex justify-center pb-1">
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  onClick={() => {
                    setHasNewBelow(false);
                    scrollMessages();
                  }}
                >
                  New messages below
                </Button>
              </div>
            ) : null}
          </div>

          {recheckState === "error" ? (
            <div className="border-t border-destructive/30 bg-destructive/5 px-4 py-3" role="alert">
              <span className="text-meta text-destructive">{recheckError}</span>
            </div>
          ) : null}

          {recheckState === "sent" ? (
            <div className="border-t border-border/50 bg-muted/40 px-4 py-3">
              <span className="text-meta text-muted-foreground">
                Re-check started. This verdict is superseded and can no longer be approved; the
                fresh investigation will produce a new revision for review.
              </span>
            </div>
          ) : null}

          {/* Bottom-only composer. Pills sit fixed above the rounded bar; the blank
              message surface above scrolls while this footer stays put. */}
          <PromptBar
            draft={draft}
            onDraftChange={setDraft}
            onSend={send}
            onQuickPrompt={sendPrompt}
            onRecheck={() => void requestRecheck()}
            sending={Boolean(sending)}
            mode={mode}
            recheckState={recheckState}
            inputRef={inputRef}
          />

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

"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { CheckCircle, MagnifyingGlass, PaperPlaneTilt, Plus, Trash, UserCircle } from "@phosphor-icons/react/ssr";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ReviewerEntry } from "@/lib/auth/reviewers";

import {
  removeReviewerAction,
  sendCodeAction,
  verifyReviewerAction,
  type ReviewerActionResult,
} from "./reviewer-actions";

const FILTERS = [
  { value: "all", label: "All reviewers" },
  { value: "owner", label: "Owners" },
  { value: "member", label: "Members" },
] as const;

function Message({ result }: { result: ReviewerActionResult | null }) {
  if (!result) return null;
  return (
    <p className={`text-meta ${result.ok ? "text-emerald-400" : "text-destructive"}`}>
      {result.ok ? result.message ?? "Done." : result.error}
    </p>
  );
}

/**
 * The reviewer allowlist for email intake, on the Email integration page and laid out like the
 * integrations list: a search box, a role filter, then the rows. Owners come from the environment
 * and cannot be changed here. A member an owner adds is pending until they enter the one-time code
 * Resend mailed them; only then are they authorized. The add box, the verify and resend controls,
 * and the delete buttons appear only for an owner, and every action re-checks that server-side.
 */
export function EmailReviewers({
  entries,
  canManage,
}: {
  entries: ReviewerEntry[];
  canManage: boolean;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["value"]>("all");
  const search = useRef<HTMLInputElement>(null);

  const [sendResult, sendAction, sending] = useActionState<ReviewerActionResult | null, FormData>(
    sendCodeAction,
    null,
  );
  const [verifyResult, verifyAction] = useActionState<ReviewerActionResult | null, FormData>(
    verifyReviewerAction,
    null,
  );
  const [removeResult, removeAction] = useActionState<ReviewerActionResult | null, FormData>(
    removeReviewerAction,
    null,
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      search.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const needle = query.trim().toLowerCase();
  const visible = entries.filter((entry) => {
    if (filter !== "all" && entry.role !== filter) return false;
    if (!needle) return true;
    return entry.email.toLowerCase().includes(needle);
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={search}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search reviewers"
            aria-label="Search reviewers"
            className="h-11 border-border/50 pr-11 pl-9 text-body"
          />
          <kbd className="pointer-events-none absolute top-1/2 right-3 flex size-5 -translate-y-1/2 items-center justify-center rounded bg-muted text-meta text-muted-foreground">
            /
          </kbd>
        </div>

        <Select
          items={FILTERS as unknown as { label: string; value: string }[]}
          value={filter}
          onValueChange={(value) => setFilter(value as typeof filter)}
        >
          <SelectTrigger aria-label="Filter reviewers" className="h-11 min-w-52 border-border/50 text-body">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTERS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {canManage ? (
        <form action={sendAction} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="email"
              name="email"
              required
              placeholder="reviewer@example.com"
              aria-label="New reviewer email"
              className="h-11 max-w-xs border-border/50 text-body"
            />
            <Button type="submit" disabled={sending} className="h-11">
              <Plus />
              {sending ? "Sending…" : "Add and send code"}
            </Button>
          </div>
          <Message result={sendResult} />
          <Message result={removeResult} />
        </form>
      ) : (
        <p className="text-meta text-muted-foreground">Only an owner can change this list.</p>
      )}

      {visible.length === 0 ? (
        <p className="rounded-xl border border-border/50 bg-card px-5 py-8 text-center text-body text-muted-foreground">
          Nothing matches {query ? `“${query}”` : "this filter"}.
        </p>
      ) : null}

      <ul className="flex flex-col gap-2.5">
        {visible.map((entry) => {
          const pending = entry.role === "member" && !entry.verified;
          return (
            <li
              key={entry.email}
              className="flex flex-col gap-3 rounded-xl border border-border/50 bg-card px-4 py-3.5"
            >
              <div className="flex flex-wrap items-center gap-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-background">
                  <UserCircle className="size-5" />
                </span>

                <div className="flex min-w-40 flex-1 flex-col">
                  <span className="text-body font-medium text-foreground">{entry.email}</span>
                  <span className="text-meta text-muted-foreground">
                    {entry.role === "owner"
                      ? "Owner, set in the environment"
                      : entry.verified
                        ? entry.addedByEmail
                          ? `Verified, added by ${entry.addedByEmail}`
                          : "Verified"
                        : entry.codeOutstanding
                          ? "Pending, a code was mailed to this address"
                          : "Pending, no active code. Send one to verify."}
                  </span>
                </div>

                {entry.role === "owner" ? (
                  <Badge variant="outline">owner</Badge>
                ) : entry.verified ? (
                  <Badge variant="success">
                    <CheckCircle />
                    verified
                  </Badge>
                ) : (
                  <Badge variant="secondary">pending</Badge>
                )}

                {canManage && entry.role === "member" ? (
                  <form action={removeAction}>
                    <input type="hidden" name="email" value={entry.email} />
                    <Button type="submit" size="sm" variant="destructive" aria-label={`Remove ${entry.email}`}>
                      <Trash />
                      Remove
                    </Button>
                  </form>
                ) : null}
              </div>

              {canManage && pending ? (
                <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
                  <form action={verifyAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="email" value={entry.email} />
                    <Input
                      name="code"
                      inputMode="numeric"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      required
                      placeholder="6-digit code"
                      aria-label={`Verification code for ${entry.email}`}
                      className="h-10 w-36 border-border/50 text-body"
                    />
                    <Button type="submit" size="sm" variant="outline">
                      Verify
                    </Button>
                  </form>
                  <form action={sendAction}>
                    <input type="hidden" name="email" value={entry.email} />
                    <Button type="submit" size="sm" variant="ghost" disabled={sending}>
                      <PaperPlaneTilt />
                      Resend code
                    </Button>
                  </form>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <Message result={verifyResult} />
    </div>
  );
}

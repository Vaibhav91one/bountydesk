"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { MagnifyingGlass, Plus, Trash, UserCircle } from "@phosphor-icons/react/ssr";

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

import { addReviewerAction, removeReviewerAction, type ActionResult } from "./actions";

const FILTERS = [
  { value: "all", label: "All reviewers" },
  { value: "owner", label: "Owners" },
  { value: "member", label: "Members" },
] as const;

/**
 * The reviewer allowlist, laid out like the integrations list: a search box, a role filter, then
 * the rows. Owners come from the environment and are shown but not removable here, since they are
 * the break-glass a wiped database cannot lock out; members were added here and can be removed
 * here. The add box and the delete buttons appear only for an owner, and the server action
 * re-checks that, so hiding them is courtesy rather than the gate.
 */
export function ReviewersList({
  entries,
  canManage,
}: {
  entries: ReviewerEntry[];
  canManage: boolean;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["value"]>("all");
  const search = useRef<HTMLInputElement>(null);

  const [addResult, addAction, adding] = useActionState<ActionResult | null, FormData>(
    addReviewerAction,
    null,
  );
  // One binding for every row's remove form; the address travels in the form's hidden field.
  const [removeResult, removeAction] = useActionState<ActionResult | null, FormData>(
    removeReviewerAction,
    null,
  );

  // "/" jumps to search, the same shortcut the integrations and repository lists use.
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
        <form action={addAction} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="email"
              name="email"
              required
              placeholder="reviewer@example.com"
              aria-label="New reviewer email"
              className="h-11 max-w-xs border-border/50 text-body"
            />
            <Button type="submit" disabled={adding} className="h-11">
              <Plus />
              {adding ? "Adding…" : "Add reviewer"}
            </Button>
          </div>
          {addResult && !addResult.ok ? (
            <p className="text-meta text-destructive">{addResult.error}</p>
          ) : null}
          {removeResult && !removeResult.ok ? (
            <p className="text-meta text-destructive">{removeResult.error}</p>
          ) : null}
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
        {visible.map((entry) => (
          <li
            key={entry.email}
            className="flex flex-wrap items-center gap-4 rounded-xl border border-border/50 bg-card px-4 py-3.5"
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-background">
              <UserCircle className="size-5" />
            </span>

            <div className="flex min-w-40 flex-1 flex-col">
              <span className="text-body font-medium text-foreground">{entry.email}</span>
              <span className="text-meta text-muted-foreground">
                {entry.role === "owner"
                  ? "Owner, set in the environment"
                  : entry.addedByEmail
                    ? `Member, added by ${entry.addedByEmail}`
                    : "Member"}
              </span>
            </div>

            <Badge variant={entry.role === "owner" ? "outline" : "secondary"}>{entry.role}</Badge>

            {canManage && entry.role === "member" ? (
              <form action={removeAction}>
                <input type="hidden" name="email" value={entry.email} />
                <Button type="submit" size="sm" variant="destructive" aria-label={`Remove ${entry.email}`}>
                  <Trash />
                  Remove
                </Button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

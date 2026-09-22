"use client";

import { useActionState } from "react";

import { Plus, Trash } from "@phosphor-icons/react/ssr";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ReviewerEntry } from "@/lib/auth/reviewers";

import { Panel } from "./panel";
import { addReviewerAction, removeReviewerAction, type ActionResult } from "./actions";

/**
 * The reviewer allowlist, managed in place.
 *
 * Owners come from the REVIEWER_EMAILS env and are shown but not editable here: removing one means
 * editing the env, which is the point, since they are the break-glass that a wiped database cannot
 * lock out. Members were added from this screen and can be removed from it. Only an owner sees the
 * add box and the trash buttons; the server action re-checks that, so hiding them is courtesy, not
 * the gate.
 */
export function ReviewersPanel({
  entries,
  canManage,
}: {
  entries: ReviewerEntry[];
  canManage: boolean;
}) {
  const [addResult, addAction, adding] = useActionState<ActionResult | null, FormData>(
    addReviewerAction,
    null,
  );
  // One binding for every row's remove form: the address travels in the form's hidden field, so
  // the same action serves them all.
  const [removeResult, removeAction] = useActionState<ActionResult | null, FormData>(
    removeReviewerAction,
    null,
  );

  return (
    <Panel
      title="Reviewers"
      detail="Who may sign in to operate BountyDesk and whose email reports are triaged. Owners are set in the environment; members are added here."
    >
      <ul className="flex flex-col">
        {entries.map((entry) => (
          <li
            key={entry.email}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border/50 py-2.5 last:border-b-0"
          >
            <span className="flex items-center gap-2 min-w-0">
              <span className="truncate text-body text-foreground">{entry.email}</span>
              <Badge variant={entry.role === "owner" ? "outline" : "secondary"}>{entry.role}</Badge>
            </span>
            {canManage && entry.role === "member" ? (
              <form action={removeAction}>
                <input type="hidden" name="email" value={entry.email} />
                <Button type="submit" variant="ghost" size="sm" aria-label={`Remove ${entry.email}`}>
                  <Trash />
                </Button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>

      {canManage ? (
        <form action={addAction} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="email"
              name="email"
              required
              placeholder="reviewer@example.com"
              className="max-w-xs"
            />
            <Button type="submit" disabled={adding}>
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
        <p className="text-meta text-muted-foreground">
          Only an owner can change this list.
        </p>
      )}
    </Panel>
  );
}

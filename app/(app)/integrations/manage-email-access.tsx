"use client";

import { useState, useTransition } from "react";

import { ArrowLeft, Check, CircleNotch, EnvelopeSimple, PaperPlaneTilt, Trash } from "@phosphor-icons/react/ssr";

import { Badge } from "@/components/ui/badge";
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
import type { ReviewerEntry } from "@/lib/auth/reviewers";

import { connectEmail, disconnectEmail, verifyEmail } from "./reviewer-actions";
import { OtpInput } from "./otp-input";

type View = "list" | "email" | "code" | "verified";

/**
 * Manage who may operate BountyDesk by email, all inside one dialog, the way GitHub access is
 * managed from a dialog on its own page. The list is the resting state; "Connect your email" walks
 * through entering an address, the code mailed to it, and a verified confirmation. Everything here
 * is owner-only, and every action re-checks that server-side.
 */
export function ManageEmailAccess({
  reviewers,
  canManage,
}: {
  reviewers: ReviewerEntry[];
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("list");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const members = reviewers.filter((entry) => entry.role === "member");

  function reset() {
    setView("list");
    setEmail("");
    setCode("");
    setError(null);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  function send() {
    setError(null);
    startTransition(async () => {
      const result = await connectEmail(email);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // An already-verified address returns a message and nothing to confirm.
      if (result.message) {
        reset();
        return;
      }
      setCode("");
      setView("code");
    });
  }

  function submitCode(value: string) {
    setError(null);
    startTransition(async () => {
      const result = await verifyEmail(email, value);
      if (!result.ok) {
        setError(result.error);
        setCode("");
        return;
      }
      setView("verified");
    });
  }

  function remove(target: string) {
    setError(null);
    startTransition(async () => {
      const result = await disconnectEmail(target);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button size="sm" variant="outline">Manage access</Button>} />

      <DialogContent className="sm:max-w-md">
        <DialogHeader className="items-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-background">
            <EnvelopeSimple className="size-6" />
          </span>
          <DialogTitle>Reviewers</DialogTitle>
          <DialogDescription>
            Who may sign in to operate BountyDesk and whose email reports are triaged.
          </DialogDescription>
        </DialogHeader>

        {view === "list" ? (
          <div className="flex flex-col gap-4">
            {members.length === 0 ? (
              <p className="rounded-xl border border-border/50 bg-background px-5 py-6 text-center text-body text-muted-foreground">
                No email is connected yet.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {members.map((member) => (
                  <li
                    key={member.email}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/50 bg-background px-4 py-3"
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-body text-foreground">{member.email}</span>
                      {member.verified ? (
                        <Badge variant="success" className="mt-1 w-fit">
                          <Check /> Verified
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="mt-1 w-fit">
                          Pending
                        </Badge>
                      )}
                    </div>
                    {canManage ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={pending}
                        onClick={() => remove(member.email)}
                        aria-label={`Remove ${member.email}`}
                      >
                        <Trash /> Remove
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {error ? <p className="text-meta text-destructive">{error}</p> : null}

            {canManage ? (
              <Button
                onClick={() => {
                  setEmail("");
                  setError(null);
                  setView("email");
                }}
              >
                <EnvelopeSimple />
                Connect your email
              </Button>
            ) : (
              <p className="text-meta text-muted-foreground">Only an owner can change this list.</p>
            )}
          </div>
        ) : null}

        {view === "email" ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <label className="flex flex-col gap-1.5">
              <span className="text-meta text-muted-foreground">Email address</span>
              <Input
                type="email"
                required
                autoFocus
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="reviewer@example.com"
                className="h-11 border-border/50 text-body"
              />
            </label>
            {error ? <p className="text-meta text-destructive">{error}</p> : null}
            <div className="flex items-center justify-between gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={reset}>
                <ArrowLeft /> Back
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <CircleNotch className="animate-spin" /> : <PaperPlaneTilt />}
                {pending ? "Sending…" : "Send code"}
              </Button>
            </div>
          </form>
        ) : null}

        {view === "code" ? (
          <div className="flex flex-col items-center gap-4">
            {pending ? (
              <div className="flex flex-col items-center gap-3 py-4">
                <CircleNotch className="size-8 animate-spin text-muted-foreground" />
                <p className="text-body text-muted-foreground">Verifying…</p>
              </div>
            ) : (
              <>
                <p className="text-center text-body text-muted-foreground">
                  Enter the six-digit code sent to <span className="text-foreground">{email}</span>.
                </p>
                <OtpInput value={code} onChange={setCode} onComplete={submitCode} />
                {error ? <p className="text-meta text-destructive">{error}</p> : null}
                <div className="flex items-center justify-between gap-2 self-stretch">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setView("email")}>
                    <ArrowLeft /> Back
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={send}>
                    <PaperPlaneTilt /> Resend code
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : null}

        {view === "verified" ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <span className="flex size-16 items-center justify-center rounded-full bg-emerald-500">
              <Check weight="bold" className="size-8 text-white" />
            </span>
            <p className="text-heading text-foreground">Verified</p>
            <p className="text-center text-body text-muted-foreground">
              <span className="text-foreground">{email}</span> can now operate BountyDesk.
            </p>
            <Button variant="outline" onClick={reset}>
              Done
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

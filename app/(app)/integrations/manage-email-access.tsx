"use client";

import { useState, useTransition } from "react";

import { Gmail } from "developer-icons";
import { ArrowLeft, Check, CircleNotch, PaperPlaneTilt, Trash } from "@phosphor-icons/react/ssr";

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

type Step = "choice" | "input" | "code";

/**
 * Manage who may operate BountyDesk by email, all inside one dialog, styled like the GitHub
 * access dialog on its own page. The choice screen offers the signed-in address in one click or
 * a field for another one; either way a code is mailed and entered before the row is authorized.
 * Everything is owner-only, and every action re-checks that server-side.
 */
export function ManageEmailAccess({
  reviewers,
  canManage,
  ownerEmail,
}: {
  reviewers: ReviewerEntry[];
  canManage: boolean;
  ownerEmail: string;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("choice");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const members = reviewers.filter((entry) => entry.role === "member");

  function reset() {
    setStep("choice");
    setEmail("");
    setCode("");
    setError(null);
    setNotice(null);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  // Mail a code to `target` and move to the code step. An address that is already an owner or a
  // verified member has nothing to verify, so it returns to the choice screen with a note.
  function send(target: string) {
    setError(null);
    setNotice(null);
    setEmail(target);
    startTransition(async () => {
      const result = await connectEmail(target);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.message) {
        reset();
        setNotice(result.message);
        return;
      }
      setCode("");
      setStep("code");
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
      reset();
    });
  }

  function remove(target: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await disconnectEmail(target);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button size="sm">Manage access</Button>} />

      <DialogContent className="no-scrollbar flex max-h-[85vh] flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl sm:min-h-[520px]">
        <DialogHeader className="items-center gap-3 border-b border-border/50 p-6 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-background">
            <Gmail className="size-6" />
          </span>
          <DialogTitle>Reviewers</DialogTitle>
          <DialogDescription>
            Who may sign in to operate BountyDesk and whose email reports are triaged.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 flex-col gap-5 p-6">
          {step === "choice" ? (
            <>
              {notice ? <p className="text-meta text-emerald-400">{notice}</p> : null}

              {members.length > 0 ? (
                <ul className="flex flex-col rounded-md border border-border/50 bg-background px-4">
                  {members.map((member) => (
                    <li
                      key={member.email}
                      className="flex items-center justify-between gap-3 border-b border-border/50 py-3 last:border-b-0"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-body text-foreground">{member.email}</span>
                        {member.verified ? (
                          <Check weight="bold" aria-label="Verified" className="size-4 shrink-0 text-emerald-500" />
                        ) : (
                          <span className="shrink-0 text-meta text-muted-foreground">Pending verification</span>
                        )}
                      </span>
                      {canManage ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={pending}
                          onClick={() => remove(member.email)}
                          aria-label={`Remove ${member.email}`}
                        >
                          <Trash />
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}

              {canManage ? (
                <>
                  <Button className="w-full" disabled={pending} onClick={() => send(ownerEmail)}>
                    {pending ? <CircleNotch className="animate-spin" /> : <Gmail />}
                    <span className="truncate">Continue with {ownerEmail}</span>
                  </Button>

                  <div className="flex items-center gap-3 text-meta text-muted-foreground">
                    <span className="h-px flex-1 bg-border/50" />
                    Or
                    <span className="h-px flex-1 bg-border/50" />
                  </div>

                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={pending}
                    onClick={() => {
                      setEmail("");
                      setError(null);
                      setNotice(null);
                      setStep("input");
                    }}
                  >
                    Continue with another email
                  </Button>
                  {error ? <p className="text-meta text-destructive">{error}</p> : null}
                </>
              ) : members.length === 0 ? (
                <p className="flex flex-1 items-center justify-center text-center text-body text-muted-foreground">
                  No email is connected, and only an owner can connect one.
                </p>
              ) : null}
            </>
          ) : null}

          {step === "input" ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                send(email);
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
                <Button type="button" variant="ghost" size="sm" onClick={() => setStep("choice")}>
                  <ArrowLeft /> Back
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? <CircleNotch className="animate-spin" /> : <PaperPlaneTilt />}
                  {pending ? "Sending…" : "Send code"}
                </Button>
              </div>
            </form>
          ) : null}

          {step === "code" ? (
            pending ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3">
                <CircleNotch className="size-8 animate-spin text-muted-foreground" />
                <p className="text-body text-muted-foreground">Verifying…</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4">
                <p className="text-center text-body text-muted-foreground">
                  Enter the six-digit code sent to <span className="text-foreground">{email}</span>.
                </p>
                <OtpInput value={code} onChange={setCode} onComplete={submitCode} />
                {error ? <p className="text-meta text-destructive">{error}</p> : null}
                <div className="flex items-center justify-between gap-2 self-stretch">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setStep("choice")}>
                    <ArrowLeft /> Back
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => send(email)}>
                    <PaperPlaneTilt /> Resend code
                  </Button>
                </div>
              </div>
            )
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

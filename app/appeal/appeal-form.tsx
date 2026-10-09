"use client";

import { useState, type FormEvent } from "react";

import { OtpInput } from "@/app/(app)/integrations/otp-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const FIELD = "flex flex-col gap-1.5 text-meta text-foreground";

async function post(payload: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch("/api/appeals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.ok) return { ok: true };
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return { ok: false, error: body?.error ?? `The request failed (${response.status}).` };
}

/**
 * Two steps: ask for a code, then send it with the appeal text. The reply to the first step is
 * the same whether or not the report exists, so the form says "if it matches" and nothing more.
 */
export function AppealForm({ initialReportId }: { initialReportId: string }) {
  const [reportId, setReportId] = useState(initialReportId);
  const [contact, setContact] = useState("");
  const [body, setBody] = useState("");
  const [code, setCode] = useState("");
  const [asked, setAsked] = useState(false);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(payload: Record<string, string>, onOk: () => void) {
    setPending(true);
    setError(null);
    try {
      const result = await post({ reportId: reportId.trim(), contact: contact.trim(), ...payload });
      if (result.ok) onOk();
      else setError(result.error ?? "The request failed.");
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <p role="status" className="text-body text-foreground">
        Your appeal is filed. A reviewer will read it and any change to the verdict is emailed to you
        after they approve it.
      </p>
    );
  }

  if (asked) {
    return (
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void run({ action: "submit", code, body }, () => setDone(true));
        }}
        className="flex flex-col gap-4"
      >
        <p className="text-body text-muted-foreground">
          If that address received this verdict, a six-digit code is on its way.
        </p>
        <OtpInput value={code} onChange={setCode} disabled={pending} />
        <label className={FIELD}>
          What should be reconsidered
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            required
            rows={8}
            maxLength={4000}
            className="rounded-md bg-input/50 px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
          />
        </label>
        {error ? (
          <p role="alert" className="text-body text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={pending || code.length !== 6 || !body.trim()} loading={pending}>
            File appeal
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => void run({ action: "request_code" }, () => setCode(""))}
          >
            Send a new code
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void run({ action: "request_code" }, () => setAsked(true));
      }}
      className="flex flex-col gap-4"
    >
      <label className={FIELD}>
        Report reference
        <Input value={reportId} onChange={(event) => setReportId(event.target.value)} required />
      </label>
      <label className={FIELD}>
        The email address the verdict was sent to
        <Input type="email" value={contact} onChange={(event) => setContact(event.target.value)} required />
      </label>
      {error ? (
        <p role="alert" className="text-body text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} loading={pending} className="w-fit">
        Email me a code
      </Button>
    </form>
  );
}

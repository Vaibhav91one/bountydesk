"use client";

import { useState, type FormEvent } from "react";

import { OtpInput } from "@/app/(app)/integrations/otp-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Material = "none" | "archive" | "dockerfile" | "image";

const FIELD = "flex flex-col gap-1.5 text-meta text-foreground";

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `The request failed (${response.status}).`;
}

/**
 * Two steps: post the report, then confirm the contact with the emailed code. Every check that
 * matters runs on the server; the limits here only save a round trip.
 */
export function UploadForm() {
  const [material, setMaterial] = useState<Material>("none");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/intake/upload", { method: "POST", body: new FormData(event.currentTarget) });
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      const body = (await response.json()) as { reportId: string; codeSent: boolean };
      setReportId(body.reportId);
      setNotice(
        body.codeSent
          ? "Report received. We sent a six-digit code to your email."
          : "Report received, but the code email did not send. Ask for a new code below.",
      );
    } finally {
      setPending(false);
    }
  }

  async function verify(payload: { code?: string; action?: "resend" }) {
    if (!reportId) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/intake/upload/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reportId, ...payload }),
      });
      if (!response.ok) {
        setError(await readError(response));
        setCode("");
        return;
      }
      if (payload.action === "resend") setNotice("A new code is on its way.");
      else setConfirmed(true);
    } finally {
      setPending(false);
    }
  }

  if (confirmed) {
    return (
      <p role="status" className="text-body text-foreground">
        Your address is confirmed. A reviewer will look at the report, and any verdict is emailed to you
        after they approve it. Report reference: {reportId}
      </p>
    );
  }

  if (reportId) {
    return (
      <div className="flex flex-col gap-4">
        {notice ? <p className="text-body text-muted-foreground">{notice}</p> : null}
        <OtpInput value={code} onChange={setCode} onComplete={(value) => verify({ code: value })} disabled={pending} />
        <div className="flex gap-2">
          <Button size="sm" onClick={() => verify({ code })} disabled={pending || code.length !== 6} loading={pending}>
            Confirm
          </Button>
          <Button size="sm" variant="outline" onClick={() => verify({ action: "resend" })} disabled={pending}>
            Send a new code
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-body text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className={FIELD}>
        Title
        <Input name="title" required maxLength={200} />
      </label>
      <label className={FIELD}>
        Report
        <textarea
          name="body"
          required
          rows={10}
          className="rounded-md bg-input/50 px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        />
      </label>
      <label className={FIELD}>
        Your email
        <Input name="contact" type="email" required autoComplete="email" />
      </label>
      <label className={FIELD}>
        Target material (optional)
        <select
          value={material}
          onChange={(event) => setMaterial(event.target.value as Material)}
          className="h-9 rounded-md bg-input/50 px-3 text-sm"
        >
          <option value="none">None</option>
          <option value="archive">Source tarball (.tar or .tar.gz with a Dockerfile at its root)</option>
          <option value="dockerfile">A Dockerfile</option>
          <option value="image">A prebuilt image and its digest</option>
        </select>
      </label>
      {material === "archive" ? (
        <label className={FIELD}>
          Tarball, up to about 4 MB
          <Input name="archive" type="file" accept=".tar,.tgz,.gz,application/gzip,application/x-tar" required />
        </label>
      ) : null}
      {material === "dockerfile" ? (
        <label className={FIELD}>
          Dockerfile
          <Input name="dockerfile" type="file" required />
        </label>
      ) : null}
      {material === "image" ? (
        <>
          <label className={FIELD}>
            Image, such as ghcr.io/org/app:1.2 (Docker Hub and GHCR unless the operator allows others)
            <Input name="imageRef" required />
          </label>
          <label className={FIELD}>
            Digest
            <Input name="imageDigest" required placeholder="sha256:..." pattern="sha256:[0-9a-fA-F]{64}" />
          </label>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-body text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} loading={pending} className="w-fit">
        Submit report
      </Button>
    </form>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { submitReviewerUploadAction } from "@/app/review/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ECOSYSTEMS } from "@/lib/build-onboarding/build-plan";

type Material = "archive" | "dockerfile" | "image";

const FIELD = "flex flex-col gap-1.5 text-meta text-foreground";

/**
 * The reviewer's upload form. It mirrors the public submit form's material fields, minus the
 * contact and OTP steps (the server binds the contact to the reviewer's session), and adds the
 * build settings the reviewer states up front. Everything is a named input inside the form, so the
 * whole thing rides in one FormData; only the material selector and the ecosystem visibility need
 * local state. Every check that matters runs in the server action.
 */
export function ReviewerUploadForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [material, setMaterial] = useState<Material>("archive");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await submitReviewerUploadAction(formData);
      if (!result.ok || !result.reportId) {
        setError(result.error ?? "The upload could not be accepted.");
        return;
      }
      router.push(`/reports/${result.reportId}`);
    });
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
          rows={8}
          className="rounded-md bg-input/50 px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        />
      </label>

      <label className={FIELD}>
        Target material
        <select
          value={material}
          onChange={(event) => setMaterial(event.target.value as Material)}
          className="h-9 rounded-md bg-input/50 px-3 text-sm"
        >
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

      <fieldset className="mt-2 flex flex-col gap-4 rounded-lg border border-border/50 p-4">
        <legend className="px-1 text-meta text-muted-foreground">How the target runs</legend>
        <label className={FIELD}>
          Port
          <Input name="port" inputMode="numeric" defaultValue="3000" required />
        </label>
        <label className={FIELD}>
          Readiness path
          <Input name="readinessPath" defaultValue="/" required />
        </label>
        <label className={FIELD}>
          Start command
          <Input name="startCommand" placeholder="Optional, the image's own command by default" />
        </label>
        {material !== "image" ? (
          <label className={FIELD}>
            Build ecosystem
            <select name="ecosystem" defaultValue="none" className="h-9 rounded-md bg-input/50 px-3 text-sm">
              {ECOSYSTEMS.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </fieldset>

      {error ? (
        <p role="alert" className="text-body text-destructive [overflow-wrap:anywhere]">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} loading={pending} className="w-fit">
        Build target and run
      </Button>
    </form>
  );
}

"use client";

import { useState } from "react";
import { DownloadSimple } from "@phosphor-icons/react/ssr";

import { Button } from "@/components/ui/button";

import { getOnboardingArtifact, type OnboardingArtifactKind } from "./actions";

/**
 * Download an onboarding artifact (Dockerfile, manifest, build plan, build log). The text lives in the
 * DB, so it is fetched on click through the reviewer-gated server action and handed to the browser as a
 * Blob, the same pattern the verdict dialog uses. No storage bucket, no file route.
 */
export function DownloadArtifact({
  repoId,
  kind,
  label,
}: {
  repoId: number;
  kind: OnboardingArtifactKind;
  label: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setPending(true);
    setError(null);
    try {
      const result = await getOnboardingArtifact(repoId, kind);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const url = URL.createObjectURL(new Blob([result.text], { type: "text/plain" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("could not fetch the file");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Button size="sm" variant="outline" loading={pending} onClick={download} className="justify-start">
        <DownloadSimple className="size-4" />
        {label}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

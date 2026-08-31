"use client";

import { useState } from "react";
import { DownloadSimple } from "@phosphor-icons/react/ssr";

import { Button } from "@/components/ui/button";
import { getArtifactDownloadUrl } from "./actions";

/**
 * Download control for one stored artifact.
 *
 * The signed URL is fetched on click, not baked into the page, because it expires. A successful
 * fetch opens the file in a new tab; a failure (the link could not be signed, or Storage went
 * away between render and click) shows the reason inline rather than a dead link.
 */
export function ArtifactDownload({
  artifactId,
  label = "Download",
}: {
  artifactId: string;
  /** What the button says. The artifacts panel lists a file per row and needs no more than
   *  "Download"; a findings sheet has one file among several sections and names it. */
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const result = await getArtifactDownloadUrl(artifactId);
      if ("url" in result) {
        window.open(result.url, "_blank", "noopener,noreferrer");
      } else {
        setError(result.error);
      }
    } catch {
      // The action itself failed to reach the server rather than refusing. Without this the
      // spinner ran forever and the button never became clickable again, which reads as a
      // download that is still working on it.
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-2">
      {error ? <span className="text-meta text-destructive">{error}</span> : null}
      <Button size="sm" variant="outline" onClick={download} loading={busy}>
        <DownloadSimple className="size-4" /> {label}
      </Button>
    </span>
  );
}

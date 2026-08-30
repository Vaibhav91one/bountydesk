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
export function ArtifactDownload({ artifactId }: { artifactId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await getArtifactDownloadUrl(artifactId);
    setBusy(false);
    if ("url" in result) {
      window.open(result.url, "_blank", "noopener,noreferrer");
    } else {
      setError(result.error);
    }
  }

  return (
    <span className="flex items-center gap-2">
      {error ? <span className="text-meta text-destructive">{error}</span> : null}
      <Button size="sm" variant="outline" onClick={download} loading={busy}>
        <DownloadSimple className="size-4" /> Download
      </Button>
    </span>
  );
}

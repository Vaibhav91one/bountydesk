import { File, Hash } from "@phosphor-icons/react/ssr";

import { Badge } from "@/components/ui/badge";
import type { CaseArtifact } from "@/lib/reports/case";

import { ArtifactDownload } from "./artifact-download";

/**
 * What a run left behind, each file addressed by its own hash.
 *
 * The rows are real artifact records (see lib/artifacts/record.ts): the investigation
 * transcript built from this session's mirrored tool calls, and the outbound verdict payload.
 * A stored artifact has a download control that mints a fresh signed URL per click; one whose
 * bytes were never uploaded (Storage not configured, or an upload that failed) says so instead
 * of offering a link that goes nowhere. The content addresses below are the pinned target image
 * and the approved payload hash, both checkable today.
 */

/** A human name for each artifact kind. Unknown kinds fall back to their raw value. */
const KIND_LABEL: Record<string, string> = {
  "investigation-transcript": "Investigation transcript",
  "verdict-payload": "Verdict payload",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function Address({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/50 py-2.5 last:border-b-0">
      <span className="flex items-center gap-2 text-meta text-muted-foreground">
        <Hash aria-hidden="true" className="size-3.5" />
        {label}
      </span>
      {/* break-all: 64 unbroken hex characters otherwise set the row's minimum width and push
          the page sideways on a phone. */}
      <span className="min-w-0 font-mono text-meta break-all text-foreground">{value}</span>
    </div>
  );
}

export function ArtifactsPanel({
  artifacts,
  imageDigest,
  contentHash,
}: {
  artifacts: CaseArtifact[];
  /** The pinned image this report would be reproduced against, if one is bound. */
  imageDigest: string | null;
  /** The hash approving binds, once a verdict has been drafted. */
  contentHash: string | null;
}) {
  const addresses = [
    imageDigest ? { label: "Target image", value: imageDigest } : null,
    contentHash ? { label: "Verdict payload", value: `sha256:${contentHash}` } : null,
  ].filter((entry) => entry !== null);

  return (
    <div className="flex flex-col gap-5">
      {artifacts.length === 0 ? (
        <p className="text-body text-muted-foreground">
          This run has recorded no artifacts.
        </p>
      ) : (
        <ul className="flex flex-col">
          {artifacts.map((art) => (
            <li
              key={art.id}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/50 py-3 last:border-b-0"
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="flex min-w-0 items-center gap-2">
                  <File aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate text-body text-foreground">
                    {KIND_LABEL[art.kind] ?? art.kind}
                  </span>
                  <Badge variant="outline">{formatBytes(art.bytes)}</Badge>
                </span>
                <span className="min-w-0 pl-5 font-mono text-meta break-all text-muted-foreground">
                  sha256:{art.sha256}
                </span>
              </span>

              {art.stored ? (
                <ArtifactDownload artifactId={art.id} />
              ) : (
                <span className="text-meta text-muted-foreground">
                  Recorded. Storage not configured, so the bytes are not downloadable.
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {addresses.length > 0 ? (
        <div className="flex flex-col gap-2">
          {/* These are real and checkable today, which is the whole reason they are here: the
              section would otherwise be a paragraph about a feature that does not exist. */}
          <span className="text-meta text-muted-foreground">Content addresses on record</span>
          <div className="flex flex-col rounded-md border border-border/50 bg-background px-4">
            {addresses.map((address) => (
              <Address key={address.label} label={address.label} value={address.value} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

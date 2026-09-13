import { File, Hash } from "@phosphor-icons/react/ssr";

import { Badge } from "@/components/ui/badge";
import type { CaseArtifactView, CaseVerdictHistoryView } from "@/lib/reports/case-view";

import { ArtifactDownload } from "./artifact-download";

/**
 * What each run left behind, each file addressed by its own hash, grouped by the verdict
 * revision that produced it.
 *
 * The rows are real artifact records (see lib/artifacts/record.ts): the investigation
 * transcript built from this session's mirrored tool calls, the outbound verdict payload, the
 * findings evidence and, for onboarded targets, the Dockerfile. Every record is keyed to the
 * verdict it belongs to, so a report that has been through a reviewer-guided re-check shows one
 * group per revision rather than one undifferentiated pile: the transcript from run 1 sits under
 * revision 1, run 2's under revision 2, and a reviewer comparing the two runs reads them as two
 * investigations instead of eight similar rows.
 *
 * A stored artifact has a download control that mints a fresh signed URL per click; one whose
 * bytes were never uploaded says so instead of offering a link that goes nowhere. Whether a row
 * has bytes is a fact about the row: storage_path records whether that upload succeeded, and
 * the table is append-only, so configuring storage afterwards cannot fill in a row that missed
 * it. Whether the next run will store its bytes is a separate question, which is why the panel
 * is told if storage is unconfigured now and says so rather than leaving an operator to read a
 * full shelf of empty rows as history. The content addresses below are the pinned target image
 * and the approved payload hash, both checkable today.
 */

/** A human name for each artifact kind. Unknown kinds fall back to their raw value. */
const KIND_LABEL: Record<string, string> = {
  "investigation-transcript": "Investigation transcript",
  "verdict-payload": "Verdict payload",
  "findings-evidence": "Findings",
  "target-dockerfile": "Target Dockerfile",
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

function ArtifactRow({ art }: { art: CaseArtifactView }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/50 py-3 last:border-b-0">
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
        <span className="max-w-xs text-meta text-muted-foreground">
          Recorded without its bytes, so there is nothing to download. Artifact rows cannot be
          rewritten, so only a later run stores them.
        </span>
      )}
    </li>
  );
}

export function ArtifactsPanel({
  artifacts,
  imageDigest,
  contentHash,
  storageConfigured,
  verdictHistory,
}: {
  artifacts: CaseArtifactView[];
  /** False when this deployment has no artifact storage configured, which is a thing an
   *  operator can fix, unlike a row that was written without bytes. */
  storageConfigured: boolean;
  /** The pinned image this report would be reproduced against, if one is bound. */
  imageDigest: string | null;
  /** The hash approving binds, once a verdict has been drafted. */
  contentHash: string | null;
  /** Every revision on record, newest first, so groups can name the run that produced them. */
  verdictHistory: CaseVerdictHistoryView[];
}) {
  const addresses = [
    imageDigest ? { label: "Target image", value: imageDigest } : null,
    contentHash ? { label: "Verdict payload", value: `sha256:${contentHash}` } : null,
  ].filter((entry) => entry !== null);

  // One group per revision, newest first, matching the order the revision history and the
  // verdict card already read. Rows whose verdict linkage is missing (revision 0) share a
  // single ungrouped section rather than each inventing their own heading.
  const byRevision = new Map<number, CaseArtifactView[]>();
  for (const art of artifacts) {
    const list = byRevision.get(art.verdictRevision);
    if (list) list.push(art);
    else byRevision.set(art.verdictRevision, [art]);
  }
  const revisionOrder = [...byRevision.keys()].sort((a, b) => b - a);
  const historyById = new Map(verdictHistory.map((v) => [v.revision, v]));

  function GroupHeading({ revision }: { revision: number }) {
    if (revision === 0) {
      return <span className="text-meta text-muted-foreground">Earlier runs</span>;
    }
    const entry = historyById.get(revision);
    return (
      <span className="flex flex-wrap items-baseline gap-2">
        <span className="text-body font-medium text-foreground">Revision {revision}</span>
        {entry ? (
          <span className="text-meta text-muted-foreground">
            {entry.outcomeLabel} · {new Date(entry.createdAt).toLocaleDateString()}
          </span>
        ) : null}
        {entry?.superseded ? <Badge variant="outline">Superseded by a re-check</Badge> : null}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {artifacts.length === 0 ? (
        <p className="text-body text-muted-foreground">
          This run has recorded no artifacts.
        </p>
      ) : (
        revisionOrder.map((revision) => (
          <div key={revision} className="flex flex-col gap-2">
            <GroupHeading revision={revision} />
            <ul className="flex flex-col">
              {byRevision.get(revision)!.map((art) => (
                <ArtifactRow key={art.id} art={art} />
              ))}
            </ul>
          </div>
        ))
      )}

      {!storageConfigured && artifacts.length > 0 ? (
        <p className="text-meta text-muted-foreground">
          Artifact storage is not configured on this deployment, so the next run will not store
          its bytes either.
        </p>
      ) : null}

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

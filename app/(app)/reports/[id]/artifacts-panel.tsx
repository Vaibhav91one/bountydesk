import { File, Hash } from "@phosphor-icons/react/ssr";

import { Badge } from "@/components/ui/badge";

/**
 * What a run left behind, and what it did not.
 *
 * The agent's own investigation is live today, but it records its claims as findings (see
 * findings-panel.tsx), not as content-addressed artifacts: no PoC script, no build attestation,
 * no oracle transcript, no negative-control log, since the canary/fixture pipeline that would
 * produce those is retained but not yet wired into the live path (docs/decisions.md Q22). The
 * panel says so rather than showing an empty list, which reads as a fetch that failed.
 *
 * verdict.evidence is where a driver will record artifact references, so this renders whatever
 * is there. The day the canary pipeline is wired in and writes them, they appear without a code
 * change, and until then nothing is invented to fill the space.
 */

export type Artifact = { name: string; kind?: string; sha256?: string; bytes?: number };

/**
 * Artifact references off a verdict's evidence, if a driver recorded any.
 *
 * Defensive about the shape because evidence is jsonb: today every row holds a single reason
 * string, and a page that trusted an `artifacts` key to be an array of objects would throw on
 * the first driver that wrote something else.
 */
export function verdictArtifacts(evidence: unknown): Artifact[] {
  if (typeof evidence !== "object" || evidence === null) return [];
  const value = (evidence as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { name, kind, sha256, bytes } = entry as Record<string, unknown>;
    if (typeof name !== "string" || name.length === 0) return [];
    return [
      {
        name,
        kind: typeof kind === "string" ? kind : undefined,
        sha256: typeof sha256 === "string" ? sha256 : undefined,
        bytes: typeof bytes === "number" ? bytes : undefined,
      },
    ];
  });
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
  artifacts: Artifact[];
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
          No run has produced an artifact. When reproduction ships, this is where the PoC that
          was executed, the build attestation for the image it ran against, the negative-control
          log and the oracle transcript will be listed, each by content hash so a reviewer can
          check that the thing described is the thing that ran.
        </p>
      ) : (
        <ul className="flex flex-col">
          {artifacts.map((artifact, index) => (
            <li
              // Name and index: a driver recording two files with the same name is not a
              // reason for the second one to vanish, which is what a duplicate key does.
              key={`${artifact.name}-${index}`}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/50 py-2.5 last:border-b-0"
            >
              <span className="flex min-w-0 items-center gap-2">
                <File aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-body text-foreground">{artifact.name}</span>
                {artifact.kind ? <Badge variant="outline">{artifact.kind}</Badge> : null}
              </span>
              <span className="min-w-0 font-mono text-meta break-all text-muted-foreground">
                {artifact.sha256 ?? "no hash recorded"}
                {typeof artifact.bytes === "number" ? ` · ${artifact.bytes} bytes` : ""}
              </span>
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

"use client";

import { useState } from "react";
import { ArrowsOut, DownloadSimple } from "@phosphor-icons/react/ssr";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { Finding } from "@/lib/mcp/publish-verdict";

import { getArtifactDownloadUrl } from "./actions";
import { ArtifactDownload } from "./artifact-download";
import { FindingDescription } from "./finding-description";

const SEVERITY_VARIANT: Record<
  Finding["severity"],
  "destructive" | "default" | "secondary" | "outline"
> = {
  critical: "destructive",
  high: "destructive",
  medium: "default",
  low: "secondary",
  info: "outline",
};

/**
 * The verdict's own words, rendered from the structured draft rather than by parsing the
 * markdown payload.
 *
 * This is the safe-by-construction path AGENTS.md asks for: the summary and each finding are the
 * agent's own text, and the agent may have read prompt-injection content off an untrusted
 * target, so every field is shown as text, never as HTML and never through a markdown renderer
 * that could interpret it. break-words and break-all keep a long unbroken token from widening
 * the card or the dialog.
 *
 * The evidence reference a finding cites is not shown. It names a file inside the harness
 * sandbox, which is a path a reviewer cannot open and cannot check; the findings file the run
 * recorded is offered instead, and it carries the references with it.
 */
export function VerdictBody({
  summary,
  findings,
  findingsArtifactId,
}: {
  summary: string;
  findings: Finding[];
  /** The recorded findings file, when one was stored. */
  findingsArtifactId?: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="whitespace-pre-wrap break-words text-body text-foreground">{summary}</p>

      {findings.length > 0 ? (
        <div className="flex flex-col gap-3">
          {findings.map((finding, index) => (
            <div
              key={index}
              className="flex min-w-0 flex-col gap-2.5 rounded-md border border-border/50 bg-background p-4"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="break-words text-body font-medium text-foreground">
                  {finding.title}
                </span>
                <Badge variant={SEVERITY_VARIANT[finding.severity]}>{finding.severity}</Badge>
              </span>
              <FindingDescription description={finding.description} />
            </div>
          ))}

          {findingsArtifactId ? (
            <span className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/50 border-dashed px-4 py-3">
              <span className="text-meta text-muted-foreground">
                Every finding above, with the evidence each one cites.
              </span>
              <ArtifactDownload artifactId={findingsArtifactId} label="Download findings" />
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The full verdict, and a way to save it.
 *
 * The card next to this shows a preview; this dialog shows the whole thing with nothing clamped,
 * and downloads the exact comment body. The download prefers the stored verdict-payload
 * artifact's signed URL (lib/storage/artifacts.ts), the same path ArtifactsPanel uses, so the
 * bytes a reviewer saves are the ones the delivery worker will send. When those bytes are not
 * stored, or the sign fails, it falls back to a Blob of the payload text this page already
 * holds, so the button is never a dead link.
 */
export function VerdictDialog({
  outcomeLabel,
  revision,
  summary,
  findings,
  payload,
  payloadArtifactId,
  findingsArtifactId,
}: {
  outcomeLabel: string;
  revision: number;
  summary: string;
  findings: Finding[];
  /** The exact outbound comment body, used for the Blob fallback. */
  payload: string;
  /** The stored verdict-payload artifact, when one exists. Null falls straight to the Blob. */
  payloadArtifactId: string | null;
  /** The stored findings file, when one exists. */
  findingsArtifactId?: string | null;
}) {
  const [busy, setBusy] = useState(false);

  function saveBlob() {
    const url = URL.createObjectURL(new Blob([payload], { type: "text/markdown" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `verdict-revision-${revision}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function download() {
    if (busy) return;
    setBusy(true);
    try {
      if (payloadArtifactId) {
        const result = await getArtifactDownloadUrl(payloadArtifactId);
        if ("url" in result) {
          window.open(result.url, "_blank", "noopener,noreferrer");
          return;
        }
      }
      // No stored bytes, or the sign failed: hand over the text the page already has rather than
      // an error the reviewer cannot act on.
      saveBlob();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline">
            <ArrowsOut className="size-4" /> View full verdict
          </Button>
        }
      />

      <DialogContent className="no-scrollbar flex max-h-[85vh] flex-col gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border/50 p-5">
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {outcomeLabel}
            <span className="text-meta font-normal text-muted-foreground">
              revision {revision}
            </span>
          </DialogTitle>
          <DialogDescription>
            The full comment as it will read on the issue, drafted by Agent Bounty.
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 p-5">
          <VerdictBody
            summary={summary}
            findings={findings}
            findingsArtifactId={findingsArtifactId}
          />
        </div>

        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-border/50 bg-card px-5 py-3">
          <Button size="sm" variant="outline" onClick={download} loading={busy}>
            <DownloadSimple className="size-4" /> Download
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

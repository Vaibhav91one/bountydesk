"use client";

import { ArrowsOut } from "@phosphor-icons/react/ssr";

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
 * The evidence reference a finding cites is not shown when the findings file is downloadable:
 * that reference names a file inside the harness sandbox, and the file the run recorded carries
 * the references with it. When no downloadable file exists (storage off, or a failed upload),
 * the reference is shown inline instead, because it is then the only citation a reviewer has.
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
              {findingsArtifactId ? null : (
                <span className="break-all font-mono text-meta text-muted-foreground">
                  Evidence: {finding.evidenceRef}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The full verdict behind a button.
 *
 * The case page keeps only the record's shape (heading, binding, decision); this dialog shows
 * the whole comment with nothing clamped. Downloads live with the artifacts panel, where every
 * revision's payload and findings file already sit, so the dialog is read-only content and
 * carries no buttons of its own.
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
  /** The exact outbound comment body. Used only to mark the artifact scope below. */
  payload: string;
  /** The stored verdict-payload artifact, when one exists. */
  payloadArtifactId: string | null;
  /** The stored findings file, when one exists. */
  findingsArtifactId?: string | null;
}) {
  // The payload and its stored artifact id are what the dialog is about; both stay in props so
  // this component keeps describing the same verdict as the artifacts panel beside it.
  void payload;
  void payloadArtifactId;

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
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useQuery } from "@tanstack/react-query";

import { SandboxDiagram } from "@/components/sandbox-diagram";
import { Badge } from "@/components/ui/badge";
import { formatStamp } from "@/lib/format";
import type { CaseLiveView } from "@/lib/reports/case-view";
import {
  caseRefetchInterval,
  caseStatusQueryKey,
  caseToolCallsQueryKey,
  fetchCaseStatus,
  fetchCaseToolCalls,
  toolCallsRefetchInterval,
} from "@/lib/reports/status-query";

import { ArtifactsPanel } from "./artifacts-panel";
import { FindingsPanel } from "./findings-panel";
import { LifecycleList } from "./lifecycle-list";
import { StatusCard } from "./status-card";
import { VerdictCard } from "./verdict-card";

function Panel({
  title,
  aside,
  children,
  className,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`flex min-w-0 flex-col gap-4 rounded-xl border border-border/50 bg-card p-5 ${className ?? ""}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-meta text-muted-foreground">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

/**
 * Everything on the case file that moves, under one query.
 *
 * The page above this stays a server component and renders the report's identity, which cannot
 * change while you are looking at it. Everything that can change lives here and reads from a
 * single CaseLiveView, so the badge, the lifecycle rows, the mascot and the verdict record are
 * always describing the same read. They used to come from two mechanisms at once (a status poll
 * for three of them, a full router.refresh for the rest) and could sit a couple of seconds apart
 * from each other, which is what made an approval look like it had not registered.
 *
 * initialData is the same view the server already built for first paint, so there is no loading
 * state and nothing flashes on mount.
 */
export function CaseView({
  reportId,
  initial,
  issueUrl,
  channel,
  repositoryFullName,
}: {
  reportId: string;
  initial: CaseLiveView;
  issueUrl: string | null;
  channel: string;
  repositoryFullName: string | null;
}) {
  const { data: status = initial } = useQuery({
    queryKey: caseStatusQueryKey(reportId),
    queryFn: () => fetchCaseStatus(reportId),
    initialData: initial,
    refetchInterval: (query) => caseRefetchInterval(query.state.data ?? initial),
  });

  // Its own query on its own cadence. This is a live read from TrueForge and it only ever fills
  // in a hover, so it must not be able to hold up anything above.
  const { data: details } = useQuery({
    queryKey: caseToolCallsQueryKey(reportId),
    queryFn: () => fetchCaseToolCalls(reportId),
    enabled: status.eventCount > 0,
    refetchInterval: () => toolCallsRefetchInterval(status),
  });

  return (
    <div className="flex flex-col gap-4 p-8">
      <StatusCard
        status={status}
        issueUrl={issueUrl}
        channel={channel}
        repositoryFullName={repositoryFullName}
      />

      {/* The pipeline beside the shape it runs through. Equal height on purpose: they are
          two views of the same run, and one of them ending early reads as unfinished. */}
      <div className="grid items-stretch gap-4 lg:grid-cols-2">
        <Panel title="Lifecycle" className="p-0">
          <LifecycleList steps={status.steps} details={details} />
        </Panel>

        <Panel
          title="Sandbox architecture"
          aside={
            <Badge variant="outline">
              {status.sandbox ? "Target provisioned" : "No sandbox"}
            </Badge>
          }
        >
          <SandboxDiagram
            repositoryFullName={repositoryFullName}
            targetName={status.target?.name ?? null}
            sandboxId={status.sandbox?.id ?? null}
          />
        </Panel>
      </div>

      {status.finalSummary ? (
        <Panel title="Summary and next steps">
          {/* The agent's own closing message, captured from its turn. Rendered as text, never
              as HTML: the agent may have read prompt-injection content while probing an
              untrusted target, so its prose is shown, not interpreted. whitespace-pre-wrap
              keeps the paragraph and list breaks it wrote. */}
          <p className="whitespace-pre-wrap text-body text-foreground">{status.finalSummary}</p>
        </Panel>
      ) : null}

      {/* No card around it. The table carries its own border, and a "Findings" header over a
          column already headed Finding was chrome saying the same word twice. */}
      {status.verdict ? (
        <FindingsPanel
          findings={status.verdict.findings}
          findingsArtifactId={status.verdict.findingsArtifactId}
        />
      ) : null}

      {/* Once the gate has closed there is no dialog to open, and the comment that went out
          would otherwise be nowhere on this page. The same card, with the decision in place
          of the buttons. Driven by the same view as the dialog above, so the two swap in one
          render rather than leaving a gap where neither is on screen. */}
      {status.verdict && !status.awaitingVerdictId ? (
        <VerdictCard
          payload={status.verdict.payload}
          payloadArtifactId={status.verdict.payloadArtifactId}
          findingsArtifactId={status.verdict.findingsArtifactId}
          outcome={status.verdict.outcome}
          outcomeLabel={status.verdict.outcomeLabel}
          summary={status.verdict.summary}
          findings={status.verdict.findings}
          revision={status.verdict.revision}
          contentHash={status.verdict.contentHash}
          destination={status.destination}
          speaker="awaiting-approval"
          speakerScope="record-speaker"
          chatMascot="greeting"
          chatMascotScope="record-chat"
          decision={
            status.approval
              ? {
                  decision: status.approval.decision,
                  reviewer: status.approval.reviewer,
                  note: status.approval.note,
                  at: formatStamp(new Date(status.approval.decidedAt)),
                }
              : null
          }
        />
      ) : null}

      <Panel
        title="Artifacts"
        aside={
          <Badge variant="outline">
            {status.artifacts.length === 0
              ? "None recorded"
              : `${status.artifacts.length} recorded`}
          </Badge>
        }
      >
        <ArtifactsPanel
          artifacts={status.artifacts}
          storageConfigured={status.storageConfigured}
          imageDigest={status.target?.imageDigest || null}
          contentHash={status.verdict?.contentHash ?? null}
        />
      </Panel>
    </div>
  );
}

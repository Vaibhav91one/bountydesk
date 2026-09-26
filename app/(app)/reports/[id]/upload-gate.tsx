"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { approveUploadTargetAction, dismissAdvisoryAction, runAnalysisAction } from "@/app/review/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ECOSYSTEMS } from "@/lib/build-onboarding/build-plan";
import { refreshReportViews } from "@/lib/reports/live-keys";
import type { UploadView } from "@/lib/upload/gate";

type Decision = "analysis" | "build" | "dismiss";

const COPY: Record<Decision, { title: string; description: string; confirm: string }> = {
  analysis: {
    title: "Run analysis without a target?",
    description:
      "Agent Bounty drafts an analysis-only verdict from the report text. Nothing is built or started, and any uploaded target material is ignored.",
    confirm: "Run analysis",
  },
  build: {
    title: "Build the uploaded target and run?",
    description:
      "The uploaded material is built in the build sandbox, pinned as a target with the settings below, and bound to this report. The target's scope is loopback only. If the build fails, the report still gets an analysis-only run.",
    confirm: "Build and run",
  },
  dismiss: {
    title: "Dismiss this upload?",
    description: "The report closes as denied and nothing runs on it. The uploader is sent nothing.",
    confirm: "Dismiss",
  },
};

const BUILD_STATE_TEXT: Record<string, string> = {
  PENDING: "The target build is queued.",
  BUILDING: "The target is building.",
  BUILT: "The target was built and bound to this report.",
  FAILED: "The target build failed, so the report runs analysis only.",
};

function materialText(upload: UploadView): string {
  if (upload.materialKind === "image") return `Prebuilt image ${upload.imageRef}@${upload.imageDigest}`;
  const size = upload.materialBytes ? ` (${Math.ceil(upload.materialBytes / 1024)} KB)` : "";
  const what = upload.materialKind === "dockerfile" ? "A Dockerfile" : "A source tarball";
  return `${what}${size}, ${upload.sourceArchiveDigest}`;
}

/**
 * The reviewer gate for an uploaded report. Anyone can upload, so nothing runs until a reviewer picks
 * one of three decisions. Building the uploaded material is its own decision, with the reviewer stating
 * how the target runs; the port, readiness path and start command are validated server-side into the
 * target definition, and the scope is never taken from the upload.
 */
export function UploadGate({ reportId, state, upload }: { reportId: string; state: string; upload: UploadView }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [port, setPort] = useState("3000");
  const [readinessPath, setReadinessPath] = useState("/");
  const [startCommand, setStartCommand] = useState("");
  const [ecosystem, setEcosystem] = useState("none");

  function confirm() {
    if (!decision) return;
    setError(null);
    startTransition(async () => {
      const result =
        decision === "analysis"
          ? await runAnalysisAction(reportId)
          : decision === "dismiss"
            ? await dismissAdvisoryAction(reportId)
            : await approveUploadTargetAction(reportId, {
                port: Number(port),
                readinessPath,
                startCommand: startCommand.trim() || undefined,
                ecosystem,
              });
      if (!result.ok) {
        setError(result.error ?? "Could not record that decision.");
        router.refresh();
        return;
      }
      setDecision(null);
      await refreshReportViews(queryClient, reportId);
      router.refresh();
    });
  }

  const contact = upload.contact
    ? `${upload.contact} (${upload.contactVerified ? "confirmed by code" : "not confirmed yet, so no verdict can be delivered to it"})`
    : "none";

  const summary = (
    <div className="flex flex-col gap-1 text-meta text-muted-foreground [overflow-wrap:anywhere]">
      <p>Contact: {contact}</p>
      <p>Target material: {upload.materialKind ? materialText(upload) : "none"}</p>
      {upload.buildState ? <p>{BUILD_STATE_TEXT[upload.buildState] ?? upload.buildState}</p> : null}
      {upload.buildError ? <p>Build error: {upload.buildError}</p> : null}
    </div>
  );

  if (state !== "NEEDS_DECISION") {
    return <section className="mx-8 mt-8 rounded-xl border border-border/50 bg-card px-5 py-4">{summary}</section>;
  }

  return (
    <section className="mx-8 mt-8 flex flex-col gap-5 rounded-xl border border-border/50 bg-card p-5">
      <header className="flex flex-col gap-1.5">
        <h2 className="text-heading text-foreground">Needs decision</h2>
        <p className="text-body text-muted-foreground">
          This report was uploaded through the public submit page, which anyone can use. Nothing runs on
          it until you decide.
        </p>
      </header>
      {summary}

      <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-4">
        {upload.materialKind && !upload.buildState ? (
          <Button size="sm" disabled={pending} onClick={() => setDecision("build")}>
            Build target and run
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={upload.materialKind ? "outline" : "default"}
          disabled={pending}
          onClick={() => setDecision("analysis")}
        >
          Run analysis
        </Button>
        <Button size="sm" variant="destructive" disabled={pending} onClick={() => setDecision("dismiss")}>
          Dismiss
        </Button>
      </div>

      <Dialog
        open={decision !== null}
        onOpenChange={(next) => {
          if (!next && !pending) {
            setDecision(null);
            setError(null);
          }
        }}
      >
        <DialogContent showCloseButton={false} className="grid-cols-[minmax(0,1fr)]">
          <DialogHeader>
            <DialogTitle>{decision ? COPY[decision].title : null}</DialogTitle>
            <DialogDescription>{decision ? COPY[decision].description : null}</DialogDescription>
          </DialogHeader>
          {decision === "build" ? (
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-meta">
              <label htmlFor="upload-port">Port</label>
              <Input id="upload-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
              <label htmlFor="upload-ready">Readiness path</label>
              <Input id="upload-ready" value={readinessPath} onChange={(e) => setReadinessPath(e.target.value)} />
              <label htmlFor="upload-start">Start command</label>
              <Input
                id="upload-start"
                placeholder="Optional, the image's own command by default"
                value={startCommand}
                onChange={(e) => setStartCommand(e.target.value)}
              />
              {upload.materialKind !== "image" ? (
                <>
                  <label htmlFor="upload-ecosystem">Build ecosystem</label>
                  <select
                    id="upload-ecosystem"
                    value={ecosystem}
                    onChange={(e) => setEcosystem(e.target.value)}
                    className="h-9 rounded-md bg-input/50 px-3 text-sm"
                  >
                    {ECOSYSTEMS.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-body text-destructive [overflow-wrap:anywhere]">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDecision(null)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant={decision === "dismiss" ? "destructive" : "default"}
              onClick={confirm}
              loading={pending}
              disabled={pending}
            >
              {decision ? COPY[decision].confirm : null}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

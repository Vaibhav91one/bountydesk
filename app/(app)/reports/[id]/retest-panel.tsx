"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { requestRetestAction } from "@/app/review/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type PanelRetest = {
  id: string;
  childReportId: string;
  commitSha: string | null;
  materialKind: string;
  actor: string;
  createdAt: string;
  /** Null while the retest is still running. */
  result: string | null;
};

const RESULT_TEXT: Record<string, string> = {
  FIXED: "Fixed: the issue no longer reproduces",
  NOT_FIXED: "Not fixed: the issue still reproduces",
  PARTIALLY_FIXED: "Partially fixed",
  INCONCLUSIVE: "Inconclusive",
};

/**
 * Fix-verification for a REPRODUCED report. The reviewer supplies the fix material: a commit SHA on
 * the connected repository, or upload material (archive, Dockerfile, image, git URL) for a
 * connectionless target. The retest runs as a separate report and its result is evidence for a human,
 * never sent to the reporter and never a change to this report's verdict.
 */
export function RetestPanel({
  reportId,
  retests,
  canStart,
  canGit = true,
  canUpload = false,
}: {
  reportId: string;
  retests: PanelRetest[];
  /** False when the report cannot be retested; the list still shows past retests. */
  canStart: boolean;
  /** Whether a commit-SHA retest is available (connected repository). */
  canGit?: boolean;
  /** Whether an upload-material retest is available (connectionless target). */
  canUpload?: boolean;
}) {
  const router = useRouter();
  const [commit, setCommit] = useState("");
  const [imageRef, setImageRef] = useState("");
  const [imageDigest, setImageDigest] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitCommitSha, setGitCommitSha] = useState("");
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"git" | "upload">(canGit ? "git" : "upload");
  const [materialType, setMaterialType] = useState<"archive" | "dockerfile" | "image" | "git">("archive");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eitherModeAvailable = canGit || canUpload;

  async function start() {
    setPending(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("mode", mode);
      if (mode === "git") {
        form.set("commitSha", commit.trim());
      } else {
        if (materialType === "archive" || materialType === "dockerfile") {
          if (archiveFile) form.set(materialType, archiveFile);
          else {
            setError("Choose a file to upload.");
            return;
          }
        } else if (materialType === "image") {
          if (imageRef) form.set("imageRef", imageRef.trim());
          if (imageDigest) form.set("imageDigest", imageDigest.trim());
        } else if (materialType === "git") {
          if (gitUrl) form.set("gitUrl", gitUrl.trim());
          if (gitCommitSha) form.set("gitCommitSha", gitCommitSha.trim());
        }
      }
      const result = await requestRetestAction(reportId, form);
      if (!result.ok) setError(result.error ?? "Could not start the retest.");
      else {
        setCommit("");
        setImageRef("");
        setImageDigest("");
        setGitUrl("");
        setGitCommitSha("");
        setArchiveFile(null);
        router.refresh();
      }
    } finally {
      setPending(false);
    }
  }

  const hasGitMaterial = mode === "git" && commit.trim().length > 0;
  const hasUploadMaterial =
    mode === "upload" &&
    ((materialType === "archive" || materialType === "dockerfile")
      ? !!archiveFile
      : materialType === "image"
        ? !!imageRef || !!imageDigest
        : !!gitUrl || !!gitCommitSha);

  return (
    <section className="flex flex-col gap-3 border-b border-border/50 px-8 py-5">
      <h2 className="text-heading text-foreground">Retest after a fix</h2>
      {canStart && eitherModeAvailable ? (
        <>
          <p className="text-meta text-muted-foreground">
            The agent builds the fixed material in a sandbox and checks whether the reported issue
            still reproduces. The result is for you; nothing is sent to the reporter.
          </p>
          <Tabs
            value={mode}
            onValueChange={(v) => {
              setMode(v as "git" | "upload");
              setError(null);
            }}
            className="w-full max-w-lg"
          >
            <TabsList>
              {canGit ? <TabsTrigger value="git">Commit SHA</TabsTrigger> : null}
              {canUpload ? <TabsTrigger value="upload">Upload material</TabsTrigger> : null}
            </TabsList>
            <TabsContent value="git">
              <p className="text-meta text-muted-foreground">
                Enter the full commit SHA that carries the fix on the connected repository. Public
                repositories clone anonymously; private ones need Contents read on the installation.
              </p>
              <Input
                value={commit}
                onChange={(event) => setCommit(event.target.value)}
                placeholder="40-character commit SHA"
                className="max-w-md font-mono"
                disabled={pending}
              />
            </TabsContent>
            <TabsContent value="upload">
              <p className="text-meta text-muted-foreground">
                Supply the fixed material for this connectionless target: a source archive, a
                Dockerfile, a prebuilt image pinned by digest, or a git URL at a commit.
              </p>
              <Select value={materialType} onValueChange={(v) => setMaterialType(v as never)}>
                <SelectTrigger className="max-w-xs">
                  <SelectValue placeholder="Material type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="archive">Source archive (.tar / .tar.gz)</SelectItem>
                  <SelectItem value="dockerfile">Dockerfile</SelectItem>
                  <SelectItem value="image">Prebuilt image (by digest)</SelectItem>
                  <SelectItem value="git">Git URL + commit</SelectItem>
                </SelectContent>
              </Select>
              {materialType === "archive" ? (
                <>
                  <label htmlFor="archive" className="text-sm font-medium leading-none">Source archive</label>
                  <Input
                    id="archive"
                    type="file"
                    accept=".tar,.tar.gz,.tgz"
                    onChange={(e) => setArchiveFile(e.target.files?.[0] ?? null)}
                    disabled={pending}
                  />
                </>
              ) : materialType === "dockerfile" ? (
                <>
                  <label htmlFor="dockerfile" className="text-sm font-medium leading-none">Dockerfile</label>
                  <Input
                    id="dockerfile"
                    type="file"
                    accept=".dockerfile,dockerfile"
                    onChange={(e) => setArchiveFile(e.target.files?.[0] ?? null)}
                    disabled={pending}
                  />
                </>
              ) : materialType === "image" ? (
                <div className="flex flex-col gap-2 max-w-md">
                  <div>
                    <label htmlFor="imageRef" className="text-sm font-medium leading-none">Image reference (name:tag)</label>
                    <Input
                      id="imageRef"
                      value={imageRef}
                      onChange={(e) => setImageRef(e.target.value)}
                      placeholder="ghcr.io/org/app:1.2"
                      disabled={pending}
                    />
                  </div>
                  <div>
                    <label htmlFor="imageDigest" className="text-sm font-medium leading-none">Image digest (sha256:…)</label>
                    <Input
                      id="imageDigest"
                      value={imageDigest}
                      onChange={(e) => setImageDigest(e.target.value)}
                      placeholder="sha256:…"
                      disabled={pending}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2 max-w-md">
                  <div>
                    <label htmlFor="gitUrl" className="text-sm font-medium leading-none">Git URL</label>
                    <Input
                      id="gitUrl"
                      value={gitUrl}
                      onChange={(e) => setGitUrl(e.target.value)}
                      placeholder="https://github.com/org/repo"
                      disabled={pending}
                    />
                  </div>
                  <div>
                    <label htmlFor="gitCommitSha" className="text-sm font-medium leading-none">Commit SHA</label>
                    <Input
                      id="gitCommitSha"
                      value={gitCommitSha}
                      onChange={(e) => setGitCommitSha(e.target.value)}
                      placeholder="40-character SHA"
                      className="font-mono"
                      disabled={pending}
                    />
                  </div>
                </div>
              )}
            </TabsContent>
          </Tabs>
          <Button
            size="sm"
            onClick={start}
            loading={pending}
            disabled={pending || (mode === "git" ? !hasGitMaterial : !hasUploadMaterial)}
          >
            Start retest
          </Button>
          {error ? <span className="whitespace-normal break-words text-meta text-destructive">{error}</span> : null}
        </>
      ) : null}
      {retests.length === 0 ? (
        <p className="text-meta text-muted-foreground">No retests yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {retests.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground"
            >
              {item.commitSha ? (
                <span className="font-mono text-foreground">{item.commitSha.slice(0, 12)}</span>
              ) : (
                <span className="font-mono text-foreground">[{item.materialKind}]</span>
              )}
              <span>{item.result ? (RESULT_TEXT[item.result] ?? item.result) : "Running"}</span>
              <span>by {item.actor}</span>
              <Link
                href={`/reports/${item.childReportId}`}
                className="text-foreground underline-offset-4 hover:text-brand-soft hover:underline"
              >
                Open the retest
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

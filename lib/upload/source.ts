import type { BuildSource } from "@/lib/build-onboarding/build-driver";
import { db, eq, uploadIntake } from "@/lib/db";

import { parseGitSource } from "./git-source";

type SourceRow = {
  materialKind: string;
  archive: Buffer | null;
  sourceArchiveDigest: string | null;
  imageRef: string | null;
  imageDigest: string | null;
  gitUrl: string | null;
  gitCommitSha: string | null;
};

/** The material as a build source. The archive digest was computed from these bytes at intake. */
export function uploadBuildSource(upload: SourceRow): BuildSource {
  if (upload.materialKind === "image") {
    if (!upload.imageRef || !upload.imageDigest) throw new Error("image material is incomplete");
    return { kind: "image", imageRef: upload.imageRef, imageDigest: upload.imageDigest };
  }
  if (upload.materialKind === "git") {
    // Re-validated at the build boundary too: the row is only as trustworthy as the code that wrote it.
    const git = parseGitSource(upload.gitUrl ?? "", upload.gitCommitSha ?? "");
    if (!git.ok) throw new Error(`git material is not valid: ${git.reason}`);
    return { kind: "git", cloneUrl: git.source.cloneUrl, resolvedCommitSha: git.source.commitSha };
  }
  if (!upload.archive || !upload.sourceArchiveDigest) throw new Error("archive material is incomplete");
  return { kind: "archive", archive: Buffer.from(upload.archive), sourceArchiveDigest: upload.sourceArchiveDigest };
}

/** The stored material of one upload, by id, as a build source (null when the row is gone). */
export async function loadUploadSource(uploadId: string): Promise<BuildSource | null> {
  const [row] = await db.select().from(uploadIntake).where(eq(uploadIntake.id, uploadId)).limit(1);
  return row ? uploadBuildSource(row as unknown as SourceRow) : null;
}

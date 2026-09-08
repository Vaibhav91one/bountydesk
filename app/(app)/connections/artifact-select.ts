export type OnboardingArtifactKind = "dockerfile" | "manifest" | "buildplan" | "buildlog";
export type ArtifactResult = { ok: true; filename: string; text: string } | { ok: false; error: string };

/** The onboarding columns an artifact download reads. */
export type OnboardingArtifactRow = {
  repoFullName: string;
  dockerfileText: string | null;
  proposedManifest: unknown;
  buildPlan: unknown;
  buildLog: string | null;
};

/**
 * Map an artifact kind to the stored column, with a download filename. Pure, so the mapping and the
 * "column empty" cases are unit-tested without a database or the reviewer gate (which is tested on its
 * own in lib/auth); getOnboardingArtifact wraps this with the gate and the row lookup.
 */
export function selectOnboardingArtifact(row: OnboardingArtifactRow, kind: OnboardingArtifactKind): ArtifactResult {
  const base = row.repoFullName.split("/").pop() ?? "target";
  switch (kind) {
    case "dockerfile":
      return row.dockerfileText
        ? { ok: true, filename: "Dockerfile", text: row.dockerfileText }
        : { ok: false, error: "no Dockerfile was recorded" };
    case "manifest":
      return row.proposedManifest
        ? { ok: true, filename: `${base}.manifest.json`, text: JSON.stringify(row.proposedManifest, null, 2) }
        : { ok: false, error: "no manifest was proposed" };
    case "buildplan":
      return row.buildPlan
        ? { ok: true, filename: `${base}.build-plan.json`, text: JSON.stringify(row.buildPlan, null, 2) }
        : { ok: false, error: "no build plan was recorded" };
    case "buildlog":
      return row.buildLog
        ? { ok: true, filename: `${base}.build.log`, text: row.buildLog }
        : { ok: false, error: "no build log was recorded" };
    default:
      return { ok: false, error: "unknown artifact" };
  }
}

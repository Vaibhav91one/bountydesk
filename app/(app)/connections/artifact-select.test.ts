import assert from "node:assert/strict";
import test from "node:test";

import { selectOnboardingArtifact, type OnboardingArtifactRow } from "./artifact-select";

const full: OnboardingArtifactRow = {
  repoFullName: "acme/thing",
  dockerfileText: "FROM node:20-slim\n",
  proposedManifest: { name: "thing" },
  buildPlan: { strategy: "agent-authored", ecosystem: "node" },
  buildLog: "#1 building\n#2 done",
};

test("each kind returns its stored text with a sensible filename", () => {
  assert.deepEqual(selectOnboardingArtifact(full, "dockerfile"), {
    ok: true,
    filename: "Dockerfile",
    text: "FROM node:20-slim\n",
  });

  const manifest = selectOnboardingArtifact(full, "manifest");
  assert.ok(manifest.ok && manifest.filename === "thing.manifest.json");

  const plan = selectOnboardingArtifact(full, "buildplan");
  assert.ok(plan.ok && plan.filename === "thing.build-plan.json" && /agent-authored/.test(plan.text));

  const log = selectOnboardingArtifact(full, "buildlog");
  assert.ok(log.ok && log.text === "#1 building\n#2 done");
});

test("a kind whose column is empty is refused with a reason", () => {
  const empty: OnboardingArtifactRow = {
    repoFullName: "acme/empty",
    dockerfileText: null,
    proposedManifest: null,
    buildPlan: null,
    buildLog: null,
  };
  for (const kind of ["dockerfile", "manifest", "buildplan", "buildlog"] as const) {
    const result = selectOnboardingArtifact(empty, kind);
    assert.equal(result.ok, false);
  }
});

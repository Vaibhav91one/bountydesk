import { commonRoot, readArchive } from "@/lib/analysis/archive-source";
import { parseBuildPlan, type BuildPlan } from "@/lib/build-onboarding/build-plan";
import { detectEcosystem, type SourceReader } from "@/lib/build-onboarding/classify";

import type { ReviewedUploadTarget } from "./gate";

/**
 * The build recipe for an uploaded source tarball that carries no Dockerfile.
 *
 * A GitHub repo with no Dockerfile goes to the onboarding agent, but that agent's tools resolve an
 * onboarding row and clone from GitHub, and an upload has neither. So the server authors a thin
 * generic-base Dockerfile itself from the detected ecosystem and the settings the reviewer already
 * approved. Nothing from the archive reaches the Dockerfile text: the archive only decides the
 * ecosystem (by which manifest files exist), and the port and start command are the reviewer's. The
 * text is data written into the build sandbox, never executed on the host, and the result is the same
 * "agent-authored" plan the driver already builds, so the build, the offline verify and the pin on the
 * archive digest are unchanged.
 */

export type ArchiveShape = { sourceReader: SourceReader; hasDockerfile: boolean; contextDir: string };

/** Inspect an archive in memory. Paths match with a single top-level directory stripped, as the
 *  static review reads the tree, and that directory becomes the build context. */
export function archiveShape(archive: Buffer): ArchiveShape {
  const { files } = readArchive(archive);
  const root = commonRoot([...files.keys()]);
  return {
    hasDockerfile: files.has("Dockerfile") || (root !== "" && files.has(`${root}Dockerfile`)),
    contextDir: root === "" ? "." : root.slice(0, -1),
    sourceReader: {
      readFile: async (path) => files.get(`${root}${path}`)?.toString("utf8") ?? null,
    },
  };
}

function thinDockerfile(base: string, install: string, port: string, command: string): string {
  return [
    `FROM ${base}`,
    "WORKDIR /app",
    "COPY . .",
    `RUN ${install}`,
    `ENV PORT=${port}`,
    `EXPOSE ${port}`,
    // JSON-quoted so a start command cannot break out of the CMD line.
    `CMD ["sh", "-c", ${JSON.stringify(command)}]`,
    "",
  ].join("\n");
}

/** The plan for a Dockerfile-less archive, or null when no recipe can be authored (an ecosystem with
 *  no template, a missing start command, or a plan that fails validation). Null is the fail-safe: the
 *  caller builds nothing and the report falls back to the static review. */
export async function thinRecipePlan(archive: Buffer, reviewed: ReviewedUploadTarget): Promise<BuildPlan | null> {
  const shape = archiveShape(archive);
  const has = async (path: string) => (await shape.sourceReader.readFile(path)) !== null;
  const ecosystem = reviewed.ecosystem !== "none" ? reviewed.ecosystem : await detectEcosystem(shape.sourceReader);

  const { definition } = reviewed;
  const baseUrl = String(definition.config.baseUrl);
  const port = new URL(baseUrl).port;
  const startCommand = definition.provisioning.startCommand;

  let dockerfileText: string;
  if (ecosystem === "node") {
    const install = (await has("package-lock.json")) ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund";
    dockerfileText = thinDockerfile("node:20-slim", install, port, startCommand ?? "npm start");
  } else if (ecosystem === "python" && startCommand) {
    // Python has no conventional entrypoint to default to, so the reviewer's start command is required.
    const install = (await has("requirements.txt"))
      ? "pip install --no-cache-dir -r requirements.txt"
      : "pip install --no-cache-dir .";
    dockerfileText = thinDockerfile("python:3.12-slim", install, port, startCommand);
  } else {
    return null;
  }

  try {
    return parseBuildPlan({
      strategy: "agent-authored",
      ecosystem,
      dockerfileText,
      buildContext: shape.contextDir,
      seed: { kind: "none" },
      runtime: {
        name: definition.name,
        baseUrl,
        readinessPath: definition.provisioning.readinessPath,
        ...(startCommand ? { startCommand } : {}),
      },
    });
  } catch {
    return null;
  }
}

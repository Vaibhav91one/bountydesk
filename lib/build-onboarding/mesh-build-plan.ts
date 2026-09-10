import type { BuildPlan, ComposeMeshService } from "./build-plan";

export type MeshBuildPlanService = {
  service: string;
  role: ComposeMeshService["role"];
  imageName: string;
  imageTag: string;
  snapshotName: string;
  build?: { context: string; dockerfile: string; dockerfileText?: string };
  image?: string;
  env?: Record<string, string>;
  peers?: string[];
  requiresBuildMarker: boolean;
};

export function meshBuildPlan(
  plan: Extract<BuildPlan, { strategy: "compose-mesh" }>,
  input: {
    ghcrNamespace: string;
    slug: string;
    buildTag: string;
  },
): MeshBuildPlanService[] {
  return plan.services.map((service) => {
    const serviceSlug = `${input.slug}-${service.service}`;
    const imageName = `${input.ghcrNamespace}/${serviceSlug}`;
    return {
      service: service.service,
      role: service.role,
      imageName,
      imageTag: `${imageName}:${input.buildTag}`,
      snapshotName: `onboarding-${serviceSlug}`,
      ...(service.build
        ? {
            build: {
              context: service.build.context,
              dockerfile: service.build.dockerfile ?? "Dockerfile",
              ...(service.build.dockerfileText ? { dockerfileText: service.build.dockerfileText } : {}),
            },
          }
        : { image: service.image! }),
      ...(service.env ? { env: service.env } : {}),
      ...(service.peers ? { peers: service.peers } : {}),
      requiresBuildMarker: Boolean(service.build),
    };
  });
}

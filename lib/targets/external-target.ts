/**
 * The escape hatch for a repo that cannot be compiled into one offline image (Q23, Tier B). Instead
 * of building a target, a reviewer may opt the profile into reaching an instance the customer already
 * runs: a staging URL, or a self-hosted runner in their cluster, the way Konvu ships. The boundary
 * then is not an offline sandbox but scope-guard plus an egress allow-list scoped to that one
 * endpoint.
 *
 * This trades away the guarantees the offline path earns, so the rule that matters most lives here:
 * an external target is not isolated or immutable, so it cannot carry a canary-backed REPRODUCED
 * unless the environment exposes a seed/reset/oracle path. Absent that, a run against it is
 * ANALYSIS_ONLY, labelled non-isolated. This module is the model and that rule; the live routing of
 * probe_target and scope-guard to the external endpoint is a separate integration.
 */

export type ExternalTargetConfig = {
  /** The reviewer-approved base URL of the running instance. Not loopback: it is a real endpoint. */
  baseUrl: string;
  /** The exact hosts scope-guard allows for this run. The endpoint's own host is always included;
   *  nothing else is reachable, and this replaces the offline sandbox's networkBlockAll. */
  egressHosts: string[];
  /** True only when the external environment exposes a way to seed an unpredictable canary and read
   *  it back through a distinct oracle channel, the way the offline path does. Almost always false
   *  for a shared staging environment, which is why the default outcome is ANALYSIS_ONLY. */
  seedable: boolean;
};

/** Whether a stored profile config describes an external (Tier B) target rather than a built image. */
export function isExternalTarget(config: unknown): boolean {
  return (
    typeof config === "object" &&
    config !== null &&
    typeof (config as { external?: unknown }).external === "object" &&
    (config as { external?: unknown }).external !== null
  );
}

/**
 * Validate the external-target block of a profile config. Throws rather than returning a partial
 * config: an external target reached with a bad endpoint or an empty allow-list is a run with no
 * boundary, which must fail at this seam.
 */
export function parseExternalTarget(config: unknown): ExternalTargetConfig {
  if (!isExternalTarget(config)) throw new Error("config has no external target block");
  const ext = (config as { external: Record<string, unknown> }).external;

  const baseUrl = ext.baseUrl;
  if (typeof baseUrl !== "string") throw new Error("external target baseUrl must be a string");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("external target baseUrl must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("external target baseUrl must be http or https");
  }
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    // Loopback is the offline path's territory; an external target that is really loopback is a
    // misconfiguration that would quietly bypass the isolation rules.
    throw new Error("external target baseUrl must not be loopback; that is the offline strategy");
  }
  if (url.username || url.password) throw new Error("external target baseUrl must not carry credentials");

  const egressHosts = Array.isArray(ext.egressHosts)
    ? ext.egressHosts.filter((h): h is string => typeof h === "string" && /^[a-z0-9.-]+$/i.test(h))
    : [];
  // The endpoint's own host is always allowed; the run can reach that and nothing else.
  const hosts = new Set<string>([url.hostname, ...egressHosts]);

  return {
    baseUrl,
    egressHosts: [...hosts].sort(),
    seedable: ext.seedable === true,
  };
}

/**
 * The integrity rule. A canary-backed REPRODUCED requires an isolated, seedable target; an external
 * target qualifies only when it declares a seed/reset/oracle path. Everything else is ANALYSIS_ONLY,
 * so a run against a shared staging environment never claims a reproduction its isolation cannot back.
 */
export function externalTargetCanReproduce(config: ExternalTargetConfig): boolean {
  return config.seedable === true;
}

/** External runs are labelled non-isolated on the verdict and in the UI, so a reader never mistakes
 *  one for an offline, deterministic reproduction. */
export function isolationLabel(external: boolean): "offline-isolated" | "external-non-isolated" {
  return external ? "external-non-isolated" : "offline-isolated";
}

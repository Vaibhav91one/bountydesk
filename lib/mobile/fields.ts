import { profileAppPort } from "@/lib/targets/authorize-reproduction";

/**
 * Display fields the phone shows that no column holds directly. Pure, so the mappings are
 * testable without a database and the case file (lib/reports/case.ts) and the card reads
 * (lib/mobile/card-extras.ts) derive them one way.
 */

export type MobileSeverity = "Critical" | "High" | "Medium" | "Low" | "Info";

const SEVERITY_RANK: Record<string, { rank: number; label: MobileSeverity }> = {
  critical: { rank: 4, label: "Critical" },
  high: { rank: 3, label: "High" },
  medium: { rank: 2, label: "Medium" },
  low: { rank: 1, label: "Low" },
  info: { rank: 0, label: "Info" },
};

/**
 * The worst finding severity in a verdict's evidence, or null.
 *
 * verdict.evidence is jsonb whose shape depends on how the verdict was drafted: the agent path
 * writes `{ findings: [{ severity }] }`, older rows carry a bare reason string or nothing. A
 * value outside the five known levels is ignored rather than passed through, so the phone never
 * renders text the agent made up.
 */
export function topSeverity(evidence: unknown): MobileSeverity | null {
  if (typeof evidence !== "object" || evidence === null) return null;
  const findings = (evidence as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return null;
  let best: { rank: number; label: MobileSeverity } | null = null;
  for (const finding of findings) {
    const raw = (finding as { severity?: unknown } | null)?.severity;
    const hit = typeof raw === "string" ? SEVERITY_RANK[raw.toLowerCase()] : undefined;
    if (hit && (!best || hit.rank > best.rank)) best = hit;
  }
  return best?.label ?? null;
}

// Neither the profile name nor its snapshot ref has a dedicated version column. Onboarded and
// demo profiles name the release in one of two places: a "-v17.3.0" name suffix, or the tag of
// the pinned sandbox snapshot ("...:v1.9-bountydesk-sandbox").
const NAME_VERSION = /-(v\d[0-9A-Za-z.]*)$/;
const SNAPSHOT_TAG_VERSION = /:(v\d[0-9A-Za-z.]*)-bountydesk-sandbox$/;

export function targetVersion(name: string | null, config: unknown): string | null {
  if (!name) return null;
  const fromName = NAME_VERSION.exec(name)?.[1];
  if (fromName) return fromName;
  const ref = (config as { provisioning?: { snapshotImageRefOverride?: unknown } } | null)?.provisioning
    ?.snapshotImageRefOverride;
  return typeof ref === "string" ? (SNAPSHOT_TAG_VERSION.exec(ref)?.[1] ?? null) : null;
}

/** The port the target's readiness check answers on: the one in the profile's baseUrl. */
export function targetPort(config: unknown): number | null {
  return profileAppPort(config);
}

/**
 * A short fixed reason for a delivery that ended FAILED or is held for a human, or null otherwise.
 * The hold is checked before the state because an email complaint sets requiresHumanReview and
 * leaves the delivery SENT (lib/email/receipts.ts).
 *
 * outbound_delivery.last_error is free text that can carry hashes, repository names and provider
 * messages, so it is only ever classified here, never forwarded. Anything unrecognised is the
 * generic reason.
 */
export function deliveryFailureReason(delivery: {
  state: string | null;
  lastError: string | null;
  requiresHumanReview: boolean | null;
}): string | null {
  if (delivery.requiresHumanReview) return "Held for human review";
  if (delivery.state !== "FAILED") return null;
  const error = delivery.lastError ?? "";
  if (/requires human review/i.test(error)) return "Held for human review";
  if (/no longer connected|verdict or repository is gone/i.test(error)) return "Repository no longer connected";
  if (/content hash mismatch|does not belong to report/i.test(error)) return "Approved text no longer matches";
  return "Delivery failed";
}

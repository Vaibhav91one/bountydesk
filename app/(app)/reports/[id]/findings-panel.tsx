import { Warning } from "@phosphor-icons/react/ssr";

import { Badge } from "@/components/ui/badge";
import type { Finding } from "@/lib/mcp/publish-verdict";

/**
 * What the agent's own investigation actually found.
 *
 * This is the agent's claim, not a certified fact: `evidenceRef` points at what backs it (an
 * artifact path, a scope-guard audit-log entry, an OSV id), so a reviewer can go check rather
 * than take the description on faith. An empty list means the run drafted a verdict with
 * nothing beyond its summary, which the summary itself already says.
 */

const SEVERITY_VARIANT: Record<Finding["severity"], "destructive" | "default" | "secondary" | "outline"> = {
  critical: "destructive",
  high: "destructive",
  medium: "default",
  low: "secondary",
  info: "outline",
};

export function FindingsPanel({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) {
    return (
      <p className="flex items-start gap-2.5 text-body text-muted-foreground">
        <Warning aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        No findings beyond the verdict&apos;s own summary were drafted for this run.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-4">
      {findings.map((finding, index) => (
        <li
          key={`${finding.title}-${index}`}
          className="flex flex-col gap-1.5 border-b border-border/50 pb-4 last:border-b-0 last:pb-0"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body font-medium text-foreground">{finding.title}</span>
            <Badge variant={SEVERITY_VARIANT[finding.severity]}>{finding.severity}</Badge>
          </div>
          <p className="text-body text-muted-foreground">{finding.description}</p>
          <span className="font-mono text-meta break-all text-muted-foreground">
            {finding.evidenceRef}
          </span>
        </li>
      ))}
    </ul>
  );
}

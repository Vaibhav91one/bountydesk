/**
 * What the re-check dialog shows about the run being superseded. Derived server-side from rows
 * the report page already loads plus investigation_run, bounded, and rendered as plain text.
 */
export type RecheckSummary = {
  runNumber: number;
  runStatus: string;
  runReason: string;
  verdictRevision: number;
  outcome: string;
  probeCount: number;
  eventCount: number;
  artifactCount: number;
  /** At most 5, in the verdict's own order. */
  findings: Array<{ title: string; severity: string }>;
  /** HH:MM:SS as the lifecycle timeline shows it, or null when there are no events. */
  lastEventAt: string | null;
};

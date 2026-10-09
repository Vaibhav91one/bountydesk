import { z } from "zod";

/**
 * The one shared shape for what an agent-drafted verdict looks like, imported by both the MCP
 * route (capability-only lookup) and the poller (the full shape, once a real agent starts
 * drafting outcome/summary/findings instead of only echoing a capability token back). One
 * definition means the two can never quietly drift on what counts as a valid draft.
 *
 * Its own module, apart from publish-verdict.ts, because the case file's read model validates
 * stored findings against the same schema and publish-verdict.ts opens a connection pool at
 * module load. A page's derived view should not have to reach the database to know what a
 * finding looks like.
 */
// CVSS 3.1's base metric group, the eight required metrics in their fixed order. Optional
// temporal and environmental metrics (E, RL, RC, CR, IR, AR, MA*, MC*, MI*, MA, MS, S) may follow,
// so the pattern anchors the required prefix and allows (but does not enumerate) anything after
// it. A reviewer reads the score this implies; a well-formed-looking vector that doesn't actually
// parse under the real spec is worse than none, so this is checked, not merely stored.
const CVSS_31_VECTOR =
  /^CVSS:3\.1\/AV:[NALP]\/AC:[LH]\/PR:[NLH]\/UI:[NR]\/S:[UC]\/C:[NLH]\/I:[NLH]\/A:[NLH](\/[A-Za-z]{1,3}:[A-Za-z0-9]{1,3})*$/;

export const findingSchema = z.object({
  title: z.string().min(1).max(200),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  description: z.string().min(1).max(4000),
  evidenceRef: z.string().min(1).max(500),
  // The agent's own drafted CVSS 3.1 vector for this finding, shown to the reviewer alongside
  // severity. Optional: a verdict drafted before this field existed, or a class the agent cannot
  // meaningfully score, still renders fine without one. There is deliberately no separate
  // reviewer-edited copy: the existing re-check-with-guidance path (lib/investigation-runs/
  // recheck.ts) is how a reviewer who disagrees with a drafted vector gets a fresh one, the same
  // way they would push back on a drafted outcome or severity today, rather than a second
  // single-field edit mechanism invented just for this.
  // 200 is generous: a full base vector plus every optional temporal/environmental metric is
  // under 100 characters. The real bound is the regex above; this is a second, cheap backstop
  // against a value built from enough repeated extension segments to still match it.
  cvssVector: z.string().max(200).regex(CVSS_31_VECTOR).optional(),
});

export const verdictDraftSchema = z.object({
  outcome: z.enum(["REPRODUCED", "NOT_REPRODUCED", "ANALYSIS_ONLY"]),
  summary: z.string().min(1).max(2000),
  findings: z.array(findingSchema).max(20),
});

export const publishVerdictInputSchema = verdictDraftSchema.extend({
  capability: z.string(),
});

export type Finding = z.infer<typeof findingSchema>;
export type VerdictDraft = z.infer<typeof verdictDraftSchema>;
export type PublishVerdictInput = z.infer<typeof publishVerdictInputSchema>;

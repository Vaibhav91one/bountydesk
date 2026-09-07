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
export const findingSchema = z.object({
  title: z.string().min(1).max(200),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  description: z.string().min(1).max(4000),
  evidenceRef: z.string().min(1).max(500),
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

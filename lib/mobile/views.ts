import { z } from "zod";

import type { CaseAppeal } from "@/lib/appeals/appeals";
import type { CaseFile } from "@/lib/reports/case-facts";
import { caseLiveView } from "@/lib/reports/case-view";

/** limit and offset for a list route. A bad value is a 400 rather than a silent default. */
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PageParams = z.infer<typeof pageSchema>;

export function parsePage(params: URLSearchParams): PageParams | null {
  const parsed = pageSchema.safeParse({
    limit: params.get("limit") ?? undefined,
    offset: params.get("offset") ?? undefined,
  });
  return parsed.success ? parsed.data : null;
}

/** One page of `items`, with the offset of the next page or null at the end. */
export function paginate<T>(items: T[], { limit, offset }: PageParams) {
  const slice = items.slice(offset, offset + limit);
  const next = offset + slice.length;
  return { items: slice, total: items.length, nextOffset: next < items.length ? next : null };
}

/**
 * The case file as the phone renders it.
 *
 * Built on caseLiveView, the same derivation the web page and its status poll use, so the state,
 * verdict and delivery here cannot disagree with the browser. Tool calls come from the mirrored
 * events (tool name plus the allowlisted argument preview), never from the live TrueForge call
 * the web hover uses: that returns un-redacted arguments and results, and nothing on a phone
 * needs them.
 *
 * `verdict.payload` and `verdict.contentHash` are the exact text a reviewer signs and the hash of
 * it. The app sends that hash back with the verdict id, and the approval gate refuses a mismatch.
 */
export function mobileCaseView(
  file: CaseFile & Parameters<typeof caseLiveView>[0],
  appeals: CaseAppeal[],
) {
  const live = caseLiveView(file);

  const events = file.events.map((event) => {
    const data =
      event.data && typeof event.data === "object"
        ? (event.data as { toolName?: unknown; argumentsPreview?: unknown })
        : {};
    return {
      seq: event.seq,
      type: event.type,
      channel: event.channel,
      at: event.at.toISOString(),
      toolName: typeof data.toolName === "string" ? data.toolName : null,
      argsPreview: typeof data.argumentsPreview === "string" ? data.argumentsPreview : null,
    };
  });

  const verdict = live.verdict;
  return {
    id: file.id,
    title: file.title,
    issueNumber: file.issueNumber,
    sourceLabel: file.sourceLabel,
    channel: file.channel,
    deliveryChannel: live.deliveryChannel,
    repositoryFullName: file.repositoryFullName,
    reporterHandle: file.reporterHandle,
    createdAt: file.createdAt.toISOString(),
    updatedAt: live.updatedAt,

    state: live.state,
    stateLabel: live.stateLabel,
    phase: live.phase,
    investigating: live.investigating,
    failed: live.failed,

    target: live.target,
    summary: live.finalSummary,
    destination: live.destination,

    verdict: verdict && {
      id: verdict.id,
      revision: verdict.revision,
      outcome: verdict.outcome,
      outcomeLabel: verdict.outcomeLabel,
      summary: verdict.summary,
      payload: verdict.payload,
      contentHash: verdict.contentHash,
      superseded: verdict.superseded,
      findings: verdict.findings,
    },
    /** What approve and deny may be sent for. Null when nothing is waiting on a reviewer. */
    awaitingVerdictId: live.awaitingVerdictId,
    approval: live.approval,
    delivery: live.delivery && {
      state: live.delivery.state,
      deliveredAt: live.delivery.deliveredAt,
      requiresHumanReview: live.delivery.requiresHumanReview,
    },

    events,
    toolCalls: events.filter((event) => event.toolName !== null),
    appeals: appeals.map((item) => ({
      id: item.id,
      status: item.status,
      body: item.body,
      createdAt: item.createdAt.toISOString(),
      resolutionNote: item.resolutionNote,
    })),
  };
}

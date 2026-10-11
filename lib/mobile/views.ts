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

/** The transport receipt label for M12, derived from the delivery target the worker recorded. */
const GITHUB_TARGET = /^github:\d+:issue:(\d+)$/;
const GITHUB_ADVISORY_TARGET = /^github:\d+:advisory:(.+)$/;

export function transportReceiptFor(delivery: {
  state: string;
  target: string | null;
}): string | null {
  if (!delivery.target) return null;
  if (GITHUB_TARGET.test(delivery.target)) {
    return `issue comment ${delivery.state === "DELIVERED" ? "2xx" : delivery.state}`;
  }
  // An advisory delivery target is github:<repoId>:advisory:<ghsaId> (or ...:advisory:create).
  // GitHub accepted the edit or creation, which is the receipt for that channel.
  if (GITHUB_ADVISORY_TARGET.test(delivery.target)) return "advisory updated";
  // An email address: Resend accepted the send and the delivered webhook confirmed it.
  if (delivery.target.includes("@")) return "email delivered";
  return delivery.state;
}

/** The type of a row as the inbox renders it, built from listAllReports. */
export type InboxCard = {
  id: string;
  title: string;
  sourceLabel: string;
  channel: string;
  targetName: string | null;
  outcome: string | null;
  verdictSuperseded: boolean;
  deliveryState: string | null;
  state: string;
  awaitingVerdictId: string | null;
  updatedAt: Date;
};

/** A paged inbox section. `truncated` is only set on "earlier": it means listAllReports hit
 * its INDEX_LIMIT cap and the full set may be larger. "needs you" is uncapped and never truncated. */
export type InboxSection = {
  items: InboxCard[];
  total: number;
  nextOffset: number | null;
  truncated?: boolean;
};

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
    /** Target profile scope and provisioning for M22, read alongside the case file. */
    targetScope: file.targetScope ?? null,
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
      target: live.delivery.target,
      transportReceipt: transportReceiptFor(live.delivery),
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

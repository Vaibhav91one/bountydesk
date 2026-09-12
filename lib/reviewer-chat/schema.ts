import { z } from "zod";

/** Limits shared by the HTTP boundary, context builder, and worker. */
export const REVIEWER_MESSAGE_MAX_LENGTH = 4_000;
export const CONTEXT_FIELD_MAX_LENGTH = 8_000;
export const REVIEWER_CHAT_FINDINGS_MAX = 20;
export const MODEL_REPLY_MAX_LENGTH = 8_000;

/**
 * Keep conversation text as text. Unicode normalization makes equivalent input hash the same,
 * while control characters cannot smuggle terminal escapes or other invisible instructions into a
 * prompt. Newlines and tabs remain useful for reproducing a reviewer's formatting.
 */
export function toPlainText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
    .trim();
}

const boundedText = (max: number) => z.string().max(max).transform(toPlainText);

/** The only fields a browser may submit for a reviewer turn. */
export const reviewerMessageSchema = z.object({
  clientRequestId: z.string().max(200).transform(toPlainText).refine((value) => value.length > 0, {
    message: "Client request ID cannot be empty",
  }),
  body: boundedText(REVIEWER_MESSAGE_MAX_LENGTH).refine((value) => value.length > 0, {
    message: "Reviewer message cannot be empty",
  }),
});

/** A model reply is stored and rendered as text, never as caller-provided markup. */
export const chatReplySchema = z.object({
  body: boundedText(MODEL_REPLY_MAX_LENGTH).refine((value) => value.length > 0, {
    message: "Chat reply cannot be empty",
  }),
});

const contextFindingSchema = z.object({
  title: boundedText(CONTEXT_FIELD_MAX_LENGTH),
  evidence: boundedText(CONTEXT_FIELD_MAX_LENGTH),
});

/**
 * Server-loaded fields that may be placed in a chat prompt. Deliberately no capability, grant,
 * credential, header, or tool-result field exists here. Zod strips unknown keys before context is
 * rendered, so adding an accidental field at a call site cannot widen the prompt boundary.
 */
export const reviewerChatContextSchema = z.object({
  reportBody: boundedText(CONTEXT_FIELD_MAX_LENGTH),
  summary: boundedText(CONTEXT_FIELD_MAX_LENGTH),
  findings: z.array(contextFindingSchema).max(REVIEWER_CHAT_FINDINGS_MAX),
  targetName: boundedText(500).optional(),
  targetIdentityHash: boundedText(256).optional(),
  outcome: z.string().max(100).transform(toPlainText).optional(),
  verdictRevision: z.number().int().nonnegative().optional(),
  verdictContentHash: boundedText(256).optional(),
});

export type ReviewerMessage = z.infer<typeof reviewerMessageSchema>;
export type ChatReply = z.infer<typeof chatReplySchema>;
export type ReviewerChatContext = z.input<typeof reviewerChatContextSchema>;
export type ParsedReviewerChatContext = z.output<typeof reviewerChatContextSchema>;

export const UNTRUSTED_REPORT_DATA_START = "[UNTRUSTED_REPORT_DATA]";
export const UNTRUSTED_REPORT_DATA_END = "[/UNTRUSTED_REPORT_DATA]";

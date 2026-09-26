import { ne } from "drizzle-orm";

import { and, db, desc, eq, outboundDelivery, report, sql } from "@/lib/db";
import { recordEvent } from "@/lib/reports/lifecycle";

export type RetryHeldResult = { ok: true; deliveryId: string } | { ok: false; reason: string };

/**
 * Put a held delivery back in the queue after a reviewer has fixed whatever held it.
 *
 * A hold (requires_human_review) takes an outbox row out of claim() for good, and the report sits
 * in DELIVERING. This is the only way back. It changes nothing a send depends on: the row keeps its
 * verdict, target, approved hash and idempotency key, so the next attempt runs every gate the
 * worker runs for any claim (payload hash, APPROVED decision, report still DELIVERING, the arm's own
 * live grant or recipient check) and finds its own earlier send through the delivery marker or the
 * provider message id instead of sending twice.
 *
 * Only the report's newest delivery is retried, which is the one the case file shows. A row that
 * the provider already accepted (a bounced email carries its provider_message_id) is refused: the
 * same idempotency key cannot send it again, and a retry would only mark it sent a second time.
 */
export async function retryHeldDelivery(
  reportId: string,
  reviewer: string,
): Promise<RetryHeldResult> {
  return db.transaction(async (tx): Promise<RetryHeldResult> => {
    // The report lock serialises this with the worker's DELIVERED transition and with a double click.
    const [reportRow] = await tx
      .select({ state: report.state })
      .from(report)
      .where(eq(report.id, reportId))
      .for("update");
    if (!reportRow) return { ok: false, reason: "report not found" };
    if (reportRow.state !== "DELIVERING") {
      return { ok: false, reason: `report is ${reportRow.state}, not DELIVERING` };
    }

    const [row] = await tx
      .select({
        id: outboundDelivery.id,
        verdictId: outboundDelivery.verdictId,
        target: outboundDelivery.target,
        state: outboundDelivery.state,
        requiresHumanReview: outboundDelivery.requiresHumanReview,
        providerMessageId: outboundDelivery.providerMessageId,
        lastError: outboundDelivery.lastError,
      })
      .from(outboundDelivery)
      .where(eq(outboundDelivery.reportId, reportId))
      .orderBy(desc(outboundDelivery.createdAt))
      .limit(1)
      .for("update");
    if (!row || !row.requiresHumanReview || row.state !== "FAILED") {
      return { ok: false, reason: "no held delivery to retry" };
    }
    if (row.providerMessageId) {
      return {
        ok: false,
        reason: "the provider already accepted this send, so it cannot be sent again",
      };
    }

    // A row held because another delivery already owns this verdict and target stays held: clearing
    // the flag would make two automatic deliveries of the same approved text.
    const [owner] = await tx
      .select({ id: outboundDelivery.id })
      .from(outboundDelivery)
      .where(
        and(
          eq(outboundDelivery.verdictId, row.verdictId),
          eq(outboundDelivery.target, row.target),
          eq(outboundDelivery.requiresHumanReview, false),
          ne(outboundDelivery.id, row.id),
        ),
      )
      .limit(1);
    if (owner) {
      return { ok: false, reason: "another delivery already owns this verdict and destination" };
    }

    // attempts is not reset: delivery_attempt is keyed (delivery_id, attempt) and append-only, so a
    // reused number would drop the retry's record. The ceiling moves up by one fresh budget instead.
    await tx
      .update(outboundDelivery)
      .set({
        state: "PENDING",
        requiresHumanReview: false,
        leaseOwner: null,
        leaseExpiresAt: null,
        maxAttempts: sql`${outboundDelivery.attempts} + 8`,
        nextAttemptAt: sql`now()`,
        updatedAt: new Date(),
      })
      .where(eq(outboundDelivery.id, row.id));

    await recordEvent(
      reportId,
      "delivery.retry_requested",
      { reviewer, deliveryId: row.id, previousError: row.lastError },
      { tx },
    );
    return { ok: true, deliveryId: row.id };
  });
}

import { createHash } from "node:crypto";

import { and, db, eq, inArray, reviewerChatMessage, reviewerChatThread, report, sql, verdict, type Executor } from "@/lib/db";
import { computeContentHash } from "@/lib/verdicts/hash";

import { chatReplySchema, reviewerMessageSchema, toPlainText, type ReviewerMessage } from "./schema";

/** A chat turn may retry, but a permanently broken provider should not spin forever. */
export const MAX_ATTEMPTS = 8;
export const CHAT_AGENT_NAME = "bountydesk-chat";
export const CHAT_MODEL_NAME = "bountydesk-chat";
const AGENT_RESPONSE_SUFFIX = ":agent";

export type ChatThreadStatus = (typeof reviewerChatThread.status.enumValues)[number];

export type ChatLease = {
  id: string;
  threadId: string;
  reportId: string;
  clientRequestId: string;
  body: string;
  attempts: number;
  fence: number;
  owner: string;
  trueforgeSessionId: string | null;
};

export class LeaseLostError extends Error {
  constructor(threadId: string) {
    super(`lease on reviewer chat thread ${threadId} is no longer held by this worker`);
    this.name = "LeaseLostError";
  }
}

export class ChatInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatInvariantError";
  }
}

export function responseClientRequestId(clientRequestId: string): string {
  const responseId = `${clientRequestId}${AGENT_RESPONSE_SUFFIX}`;
  if (responseId.length > 200) {
    throw new ChatInvariantError("client request ID is too long for the agent response record");
  }
  return responseId;
}

function bodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function enabledFromEnvironment(): boolean {
  return process.env.REVIEWER_CHAT_ENABLED?.trim().toLowerCase() === "true";
}

/** The worker and HTTP surface are both off unless an operator explicitly enables the feature. */
export function reviewerChatEnabled(): boolean {
  return enabledFromEnvironment();
}

export type EnqueueInput = ReviewerMessage & {
  reportId: string;
  reviewerId: string;
};

export type EnqueueResult = {
  threadId: string;
  messageId: string;
  clientRequestId: string;
  disposition: "CREATED" | "DUPLICATE";
  status: "PENDING" | "DONE";
  responseBody: string | null;
};

type ExistingMessage = {
  threadId: string;
  messageId: string;
  clientRequestId: string;
  body: string;
};

async function responseFor(
  tx: Executor,
  threadId: string,
  clientRequestId: string,
): Promise<{ body: string } | null> {
  const [response] = await tx
    .select({ body: reviewerChatMessage.body })
    .from(reviewerChatMessage)
    .where(
      and(
        eq(reviewerChatMessage.threadId, threadId),
        eq(reviewerChatMessage.clientRequestId, responseClientRequestId(clientRequestId)),
        eq(reviewerChatMessage.sender, "AGENT"),
      ),
    )
    .limit(1);
  return response ?? null;
}

async function findExistingMessage(
  tx: Executor,
  reportId: string,
  clientRequestId: string,
): Promise<ExistingMessage | null> {
  const [existing] = await tx
    .select({
      threadId: reviewerChatThread.id,
      messageId: reviewerChatMessage.id,
      clientRequestId: reviewerChatMessage.clientRequestId,
      body: reviewerChatMessage.body,
    })
    .from(reviewerChatMessage)
    .innerJoin(reviewerChatThread, eq(reviewerChatMessage.threadId, reviewerChatThread.id))
    .where(
      and(
        eq(reviewerChatThread.reportId, reportId),
        eq(reviewerChatMessage.clientRequestId, clientRequestId),
        eq(reviewerChatMessage.sender, "REVIEWER"),
      ),
    )
    .limit(1);
  return existing ?? null;
}

/**
 * Enqueue one reviewer message and bind it to the verdict snapshot loaded by the server.
 * The report row is locked while choosing or creating the thread, so concurrent first messages
 * cannot create two threads for the same active verdict. Browser input never supplies verdict ids,
 * hashes, session ids, or target fields.
 */
async function enqueueMessageInTx(
  input: EnqueueInput,
  tx: Executor,
): Promise<EnqueueResult> {
  const parsed = reviewerMessageSchema.parse({
    clientRequestId: input.clientRequestId,
    body: input.body,
  });
  const reviewerId = toPlainText(input.reviewerId);
  if (!reviewerId || reviewerId.length > 200) throw new Error("reviewer ID is invalid");

  // This lock also makes the duplicate lookup and thread selection one serializable decision for
  // callers that submit the same clientRequestId concurrently.
  await tx.execute(sql`select id from ${report} where id = ${input.reportId} for update`);

  const duplicate = await findExistingMessage(tx, input.reportId, parsed.clientRequestId);
  if (duplicate) {
    const response = await responseFor(tx, duplicate.threadId, parsed.clientRequestId);
    return {
      threadId: duplicate.threadId,
      messageId: duplicate.messageId,
      clientRequestId: duplicate.clientRequestId,
      disposition: "DUPLICATE",
      status: response ? "DONE" : "PENDING",
      responseBody: response?.body ?? null,
    };
  }

  const [activeThread] = await tx
    .select({
      id: reviewerChatThread.id,
      verdictId: reviewerChatThread.verdictId,
      verdictRevision: reviewerChatThread.verdictRevision,
      verdictContentHash: reviewerChatThread.verdictContentHash,
      reviewerId: reviewerChatThread.reviewerId,
    })
    .from(reviewerChatThread)
    .where(
      and(
        eq(reviewerChatThread.reportId, input.reportId),
        inArray(reviewerChatThread.status, ["OPEN", "RUNNING"]),
      ),
    )
    .orderBy(reviewerChatThread.createdAt)
    .limit(1);

  let threadId: string;
  if (activeThread) {
    threadId = activeThread.id;
  } else {
    const [currentVerdict] = await tx
      .select({
        id: verdict.id,
        revision: verdict.revision,
        contentHash: verdict.contentHash,
        payload: verdict.payload,
      })
      .from(verdict)
      .where(eq(verdict.reportId, input.reportId))
      .orderBy(sql`${verdict.revision} desc`)
      .limit(1);

    if (currentVerdict && computeContentHash(currentVerdict.payload) !== currentVerdict.contentHash) {
      throw new ChatInvariantError("current verdict content hash does not match its payload");
    }

    const [created] = await tx
      .insert(reviewerChatThread)
      .values({
        reportId: input.reportId,
        reviewerId,
        ...(currentVerdict
          ? {
              verdictId: currentVerdict.id,
              verdictRevision: currentVerdict.revision,
              verdictContentHash: currentVerdict.contentHash,
            }
          : {}),
      })
      .returning({ id: reviewerChatThread.id });
    threadId = created.id;
  }

  const [message] = await tx
    .insert(reviewerChatMessage)
    .values({
      threadId,
      clientRequestId: parsed.clientRequestId,
      sender: "REVIEWER",
      body: parsed.body,
      bodyHash: bodyHash(parsed.body),
    })
    .returning({ id: reviewerChatMessage.id });

  return {
    threadId,
    messageId: message.id,
    clientRequestId: parsed.clientRequestId,
    disposition: "CREATED",
    status: "PENDING",
    responseBody: null,
  };
}

export async function enqueueMessage(
  input: EnqueueInput,
  tx: Executor = db,
): Promise<EnqueueResult> {
  // The report lock, duplicate lookup, thread creation, and message insert must commit together.
  // A caller may pass an existing transaction from an intake/action boundary; otherwise open one
  // here so a failed insert cannot leave an empty thread behind.
  if (tx === db) return db.transaction((inner) => enqueueMessageInTx(input, inner));
  return enqueueMessageInTx(input, tx);
}

function heldBy(lease: ChatLease) {
  return and(
    eq(reviewerChatThread.id, lease.threadId),
    eq(reviewerChatThread.leaseOwner, lease.owner),
    eq(reviewerChatThread.fence, lease.fence),
    eq(reviewerChatThread.status, "RUNNING"),
    sql`${reviewerChatThread.leaseExpiresAt} > now()`,
  );
}

/** Claim one thread with pending reviewer work, skipping rows another worker has locked. */
export async function claim(owner: string, leaseSeconds = 60): Promise<ChatLease | null> {
  if (!owner.trim()) throw new Error("owner is required");
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) throw new Error("leaseSeconds must be greater than zero");

  const rows = await db.execute<{
    id: string;
    report_id: string;
    attempts: number;
    fence: string | number;
    trueforge_session_id: string | null;
  }>(sql`
    update ${reviewerChatThread}
       set status = 'RUNNING',
           lease_owner = ${owner},
           lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
           attempts = ${reviewerChatThread.attempts} + 1,
           fence = ${reviewerChatThread.fence} + 1,
           updated_at = now()
     where ${reviewerChatThread.id} = (
       select t.id
         from ${reviewerChatThread} t
        where t.status in ('OPEN', 'RUNNING', 'ERROR')
          and t.attempts < ${MAX_ATTEMPTS}
          and (t.lease_expires_at is null or t.lease_expires_at < now())
          and exists (
            select 1 from ${reviewerChatMessage} m
             where m.thread_id = t.id
               and m.sender = 'REVIEWER'
               and not exists (
                 select 1 from ${reviewerChatMessage} a
                  where a.thread_id = t.id
                    and a.sender = 'AGENT'
                    and a.client_request_id = m.client_request_id || ${AGENT_RESPONSE_SUFFIX}
               )
          )
        order by t.updated_at, t.created_at
        limit 1
        for update skip locked
     )
    returning ${reviewerChatThread.id} as id,
              ${reviewerChatThread.reportId} as report_id,
              ${reviewerChatThread.attempts} as attempts,
              ${reviewerChatThread.fence} as fence,
              ${reviewerChatThread.trueforgeSessionId} as trueforge_session_id
  `);
  const row = rows[0];
  if (!row) return null;

  const [message] = await db
    .select({
      id: reviewerChatMessage.id,
      clientRequestId: reviewerChatMessage.clientRequestId,
      body: reviewerChatMessage.body,
    })
    .from(reviewerChatMessage)
    .where(
      and(
        eq(reviewerChatMessage.threadId, row.id),
        eq(reviewerChatMessage.sender, "REVIEWER"),
        sql`not exists (
          select 1 from ${reviewerChatMessage} a
           where a.thread_id = ${reviewerChatMessage.threadId}
             and a.sender = 'AGENT'
             and a.client_request_id = ${reviewerChatMessage.clientRequestId} || ${AGENT_RESPONSE_SUFFIX}
        )`,
      ),
    )
    .orderBy(reviewerChatMessage.createdAt)
    .limit(1);

  if (!message) {
    // The selected row cannot normally lose its message because messages are append-only, but do
    // not leave a lease stranded if a future migration changes that guarantee.
    await db
      .update(reviewerChatThread)
      .set({ status: "OPEN", leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
      .where(eq(reviewerChatThread.id, row.id));
    return null;
  }

  return {
    id: message.id,
    threadId: row.id,
    reportId: row.report_id,
    clientRequestId: message.clientRequestId,
    body: message.body,
    attempts: row.attempts,
    fence: Number(row.fence),
    owner,
    trueforgeSessionId: row.trueforge_session_id,
  };
}

export async function renew(lease: ChatLease, leaseSeconds: number): Promise<void> {
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) throw new Error("leaseSeconds must be greater than zero");
  const rows = await db
    .update(reviewerChatThread)
    .set({ leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`, updatedAt: new Date() })
    .where(heldBy(lease))
    .returning({ id: reviewerChatThread.id });
  if (rows.length === 0) throw new LeaseLostError(lease.threadId);
}

export async function releaseUnstarted(lease: ChatLease): Promise<void> {
  const rows = await db
    .update(reviewerChatThread)
    .set({
      status: "OPEN",
      attempts: sql`greatest(${reviewerChatThread.attempts} - 1, 0)`,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(heldBy(lease))
    .returning({ id: reviewerChatThread.id });
  if (rows.length === 0) throw new LeaseLostError(lease.threadId);
}

async function updateHeld(
  lease: ChatLease,
  patch: Partial<typeof reviewerChatThread.$inferInsert>,
): Promise<void> {
  // Lock and validate first, then mutate the same row in this transaction. Keeping the clock check
  // in the locked read avoids a lease boundary race where a long transaction evaluates `now()`
  // against a stale snapshot during a subsequent update.
  await db.transaction(async (tx) => {
    const [held] = await tx
      .select({
        owner: reviewerChatThread.leaseOwner,
        fence: reviewerChatThread.fence,
        status: reviewerChatThread.status,
        expiresAt: reviewerChatThread.leaseExpiresAt,
      })
      .from(reviewerChatThread)
      .where(eq(reviewerChatThread.id, lease.threadId))
      .for("update");
    if (
      !held ||
      held.owner !== lease.owner ||
      Number(held.fence) !== lease.fence ||
      held.status !== "RUNNING" ||
      !held.expiresAt ||
      held.expiresAt.getTime() <= Date.now()
    ) {
      throw new LeaseLostError(lease.threadId);
    }
    const updated = await tx
      .update(reviewerChatThread)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(reviewerChatThread.id, lease.threadId))
      .returning({ id: reviewerChatThread.id });
    if (updated.length === 0) throw new LeaseLostError(lease.threadId);
  });
}

export async function attachSession(lease: ChatLease, sessionId: string): Promise<void> {
  await updateHeld(lease, { trueforgeSessionId: sessionId });
}

export async function recordTurn(lease: ChatLease, turnId: string): Promise<void> {
  await updateHeld(lease, {});
  // The schema intentionally keeps only the session id on the chat thread. The turn id is carried
  // by the immutable agent message, and never becomes authority supplied by a browser caller.
  void turnId;
}

/** Persist a bounded agent answer and release the lease in one transaction. */
export async function complete(
  lease: ChatLease,
  response: { body: string; providerTurnId: string },
): Promise<void> {
  const parsed = chatReplySchema.safeParse({ body: response.body });
  if (!parsed.success) throw new ChatInvariantError("TrueForge returned an empty, oversize, or invalid chat response");
  const body = parsed.data.body;

  // Complete is the only path that writes both the immutable response and the lease release. Use
  // one database transaction even when a caller supplied an executor for reads; partial completion
  // would leave a response that a retry cannot safely associate with its lease.
  await db.transaction(async (inner) => {
    const held = await inner
      .select({ id: reviewerChatThread.id })
      .from(reviewerChatThread)
      .where(heldBy(lease))
      .for("update");
    if (held.length === 0) throw new LeaseLostError(lease.threadId);

    await inner
      .insert(reviewerChatMessage)
      .values({
        threadId: lease.threadId,
        clientRequestId: responseClientRequestId(lease.clientRequestId),
        sender: "AGENT",
        body,
        bodyHash: bodyHash(body),
        modelName: CHAT_MODEL_NAME,
        providerTurnId: response.providerTurnId,
      })
      .onConflictDoNothing({
        target: [reviewerChatMessage.threadId, reviewerChatMessage.clientRequestId],
      });

    const updated = await inner
      .update(reviewerChatThread)
      .set({
        status: sql`case when exists (
          select 1 from ${reviewerChatMessage} m
           where m.thread_id = ${reviewerChatThread.id}
             and m.sender = 'REVIEWER'
             and not exists (
               select 1 from ${reviewerChatMessage} a
                where a.thread_id = m.thread_id
                  and a.sender = 'AGENT'
                  and a.client_request_id = m.client_request_id || ${AGENT_RESPONSE_SUFFIX}
             )
        ) then 'OPEN'::reviewer_chat_thread_status else 'DONE'::reviewer_chat_thread_status end`,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(reviewerChatThread.id, lease.threadId))
      .returning({ id: reviewerChatThread.id });
    if (updated.length === 0) throw new LeaseLostError(lease.threadId);
  });
}

export async function fail(lease: ChatLease): Promise<void> {
  await updateHeld(lease, { status: "ERROR", leaseOwner: null, leaseExpiresAt: null });
}

/** Stop retries for an invariant or output violation. The message history remains immutable. */
export async function cancel(lease: ChatLease): Promise<void> {
  await updateHeld(lease, { status: "CANCELLED", leaseOwner: null, leaseExpiresAt: null });
}

export async function sweepExpiredLeases(): Promise<{ released: number; failed: number }> {
  const failed = await db
    .update(reviewerChatThread)
    .set({ status: "ERROR", leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(reviewerChatThread.status, "RUNNING"),
        sql`${reviewerChatThread.leaseExpiresAt} < now()`,
        sql`${reviewerChatThread.attempts} >= ${MAX_ATTEMPTS}`,
      ),
    )
    .returning({ id: reviewerChatThread.id });

  const released = await db
    .update(reviewerChatThread)
    .set({ status: "OPEN", leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(reviewerChatThread.status, "RUNNING"),
        sql`${reviewerChatThread.leaseExpiresAt} < now()`,
        sql`${reviewerChatThread.attempts} < ${MAX_ATTEMPTS}`,
      ),
    )
    .returning({ id: reviewerChatThread.id });
  return { released: released.length, failed: failed.length };
}

export type ChatStatus = {
  reportId: string;
  threads: Array<{
    id: string;
    verdictId: string | null;
    verdictRevision: number | null;
    verdictContentHash: string | null;
    status: ChatThreadStatus;
    createdAt: Date;
    updatedAt: Date;
    messages: Array<{
      id: string;
      clientRequestId: string;
      sender: "REVIEWER" | "AGENT" | "SYSTEM";
      body: string;
      bodyHash: string;
      modelName: string | null;
      providerTurnId: string | null;
      createdAt: Date;
    }>;
  }>;
};

/** Read-only reviewer view. It never returns session, lease, target, or provider credentials. */
export async function readChatStatus(reportId: string): Promise<ChatStatus | null> {
  const [exists] = await db.select({ id: report.id }).from(report).where(eq(report.id, reportId)).limit(1);
  if (!exists) return null;

  const threads = await db
    .select({
      id: reviewerChatThread.id,
      verdictId: reviewerChatThread.verdictId,
      verdictRevision: reviewerChatThread.verdictRevision,
      verdictContentHash: reviewerChatThread.verdictContentHash,
      status: reviewerChatThread.status,
      createdAt: reviewerChatThread.createdAt,
      updatedAt: reviewerChatThread.updatedAt,
    })
    .from(reviewerChatThread)
    .where(eq(reviewerChatThread.reportId, reportId))
    .orderBy(reviewerChatThread.createdAt);

  const messages = await db
    .select({
      threadId: reviewerChatMessage.threadId,
      id: reviewerChatMessage.id,
      clientRequestId: reviewerChatMessage.clientRequestId,
      sender: reviewerChatMessage.sender,
      body: reviewerChatMessage.body,
      bodyHash: reviewerChatMessage.bodyHash,
      modelName: reviewerChatMessage.modelName,
      providerTurnId: reviewerChatMessage.providerTurnId,
      createdAt: reviewerChatMessage.createdAt,
    })
    .from(reviewerChatMessage)
    .innerJoin(reviewerChatThread, eq(reviewerChatMessage.threadId, reviewerChatThread.id))
    .where(eq(reviewerChatThread.reportId, reportId))
    .orderBy(reviewerChatMessage.createdAt);

  return {
    reportId,
    threads: threads.map((thread) => ({
      ...thread,
      messages: messages.filter((message) => message.threadId === thread.id).map((message) => ({
        id: message.id,
        clientRequestId: message.clientRequestId,
        sender: message.sender,
        body: message.body,
        bodyHash: message.bodyHash,
        modelName: message.modelName,
        providerTurnId: message.providerTurnId,
        createdAt: message.createdAt,
      })),
    })),
  };
}

export { bodyHash as computeMessageHash };
export type { Executor };

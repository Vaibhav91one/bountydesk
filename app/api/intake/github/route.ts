import { db, lifecycleDelivery } from "@/lib/db";
import { githubWebhookSecret } from "@/lib/env";
import { parseReproduceCommand, reproductionRequested } from "@/lib/github/commands";
import { LIFECYCLE_EVENTS, activeRepository, applyLifecycle } from "@/lib/github/lifecycle";
import { readBoundedBody, verifySignature } from "@/lib/github/webhook";
import { enqueue } from "@/lib/jobs/queue";

// node:crypto and a Postgres socket both need the Node runtime, and the streaming edge
// runtime has neither.
export const runtime = "nodejs";

type IssuePayload = {
  action?: string;
  issue?: { number?: number; title?: string; body?: string | null; user?: { login?: string } };
  sender?: { id?: number; login?: string };
  repository?: { id?: number; full_name?: string };
  installation?: { id?: number };
};

type GateResult =
  | { kind: "not_connected" }
  | { kind: "no_command" }
  | { kind: "unauthorized" }
  | { kind: "enqueued"; disposition: string };

/**
 * The GitHub App webhook endpoint.
 *
 * Order matters and is the whole security property: read a bounded number of raw bytes,
 * verify the HMAC, and only then parse. An unsigned request reaches no parser, no database
 * and no queue.
 *
 * A verified `issues.opened` is committed to the jobs table before this returns, so the 202
 * is a promise we can keep across a restart. Everything the report run needs happens later,
 * in the worker.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = await readBoundedBody(request);
  if (!rawBody) {
    return new Response("body too large", { status: 413 });
  }

  if (!verifySignature(rawBody, request.headers.get("x-hub-signature-256"), githubWebhookSecret())) {
    return new Response("invalid signature", { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");
  if (!event || !deliveryId) {
    return new Response("missing x-github-event or x-github-delivery", { status: 400 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return new Response("body is not JSON", { status: 400 });
  }

  if (LIFECYCLE_EVENTS.has(event)) {
    return handleLifecycle(deliveryId, event, payload);
  }

  if (event === "issues") {
    return handleIssue(deliveryId, payload as IssuePayload);
  }

  // A subscription we do not act on. Accepting it keeps GitHub's delivery log clean, and
  // saying so in the body keeps ours readable.
  return new Response(`ignored event ${event}`, { status: 202 });
}

/**
 * Apply an installation or repository lifecycle event, once.
 *
 * The `lifecycle_delivery` insert and the mutation share a transaction. GitHub reuses the
 * delivery id when it retries and when a human presses Redeliver, and most of these
 * handlers are upserts that would not care. `installation.created` is the one that does:
 * replaying an old one after an uninstall would clear `deleted_at` and hand access back.
 */
async function handleLifecycle(
  deliveryId: string,
  event: string,
  payload: unknown,
): Promise<Response> {
  const applied = await db.transaction(async (tx) => {
    const claimed = await tx
      .insert(lifecycleDelivery)
      .values({
        deliveryId,
        event,
        action: (payload as { action?: string }).action ?? null,
      })
      .onConflictDoNothing({ target: lifecycleDelivery.deliveryId })
      .returning({ id: lifecycleDelivery.id });

    if (claimed.length === 0) return false;

    await applyLifecycle(tx, event, payload as Parameters<typeof applyLifecycle>[2]);
    return true;
  });

  return new Response(applied ? "applied" : "already applied", { status: 202 });
}

async function handleIssue(deliveryId: string, payload: IssuePayload): Promise<Response> {
  // ponytail: only a newly opened issue starts a run. Edits and reopens are report updates,
  // which need reply correlation to be meaningful, and that is deferred past the MVP.
  if (payload.action !== "opened") {
    return new Response(`ignored issue action ${payload.action}`, { status: 202 });
  }

  // The access check and the enqueue are one transaction, and the check locks the rows it
  // read. A suspension or a repository removal arriving concurrently either commits first,
  // and the check fails, or waits for this to commit. It cannot land in between.
  const result = await db.transaction(async (tx): Promise<GateResult> => {
    const repository = await activeRepository(
      payload.installation?.id,
      payload.repository?.id,
      { tx, lock: true },
    );

    // Suspended, uninstalled, or a repository the installation no longer covers. A signed
    // delivery for one of those is still a delivery we refuse to act on.
    if (!repository) return { kind: "not_connected" };

    // The intent gate. The capability boundary already decided which target this repository
    // may reach; this decides whether the reporter actually asked to spend it. An opened
    // issue with no `/reproduce` command is a report to triage, not a run to start, and a
    // `/reproduce` from someone off the reviewer allowlist is ignored because these repos can
    // be public and a stranger must not be able to burn the sandbox budget.
    if (!parseReproduceCommand(payload.issue?.body).matched) {
      return { kind: "no_command" };
    }
    if (!reproductionRequested(payload.issue?.body, payload.sender?.id)) {
      return { kind: "unauthorized" };
    }

    const { disposition } = await enqueue({ channel: "github", deliveryId, payload }, tx);
    return { kind: "enqueued", disposition };
  });

  if (result.kind === "not_connected") {
    return new Response("repository is not connected", { status: 202 });
  }

  if (result.kind === "no_command") {
    return new Response("no /reproduce command, not triggering a run", { status: 202 });
  }

  if (result.kind === "unauthorized") {
    return new Response("reproduce command ignored: sender not authorized", { status: 202 });
  }

  return new Response(result.disposition, { status: 202 });
}

import { githubWebhookSecret } from "@/lib/env";
import { LIFECYCLE_EVENTS, activeRepository, applyLifecycle } from "@/lib/github/lifecycle";
import { verifySignature } from "@/lib/github/webhook";
import { enqueue } from "@/lib/jobs/queue";

// node:crypto and a Postgres socket both need the Node runtime, and the streaming edge
// runtime has neither.
export const runtime = "nodejs";

type IssuePayload = {
  action?: string;
  issue?: { number?: number; title?: string; body?: string | null; user?: { login?: string } };
  repository?: { id?: number; full_name?: string };
  installation?: { id?: number };
};

/**
 * The GitHub App webhook endpoint.
 *
 * Order matters and is the whole security property: read the raw bytes, verify the HMAC,
 * and only then parse. An unsigned request reaches no parser, no database and no queue.
 *
 * A verified `issues` delivery is committed to the jobs table before this returns, so the
 * 202 is a promise we can keep across a restart. Everything the report run needs happens
 * later, in the worker.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = Buffer.from(await request.arrayBuffer());

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
    await applyLifecycle(event, payload as Parameters<typeof applyLifecycle>[1]);
    return new Response(null, { status: 202 });
  }

  if (event === "issues") {
    return handleIssue(deliveryId, payload as IssuePayload);
  }

  // A subscription we do not act on. Accepting it keeps GitHub's delivery log clean, and
  // saying so in the body keeps ours readable.
  return new Response(`ignored event ${event}`, { status: 202 });
}

async function handleIssue(deliveryId: string, payload: IssuePayload): Promise<Response> {
  // ponytail: only a newly opened issue starts a run. Edits and reopens are report updates,
  // which need reply correlation to be meaningful, and that is deferred past the MVP.
  if (payload.action !== "opened") {
    return new Response(`ignored issue action ${payload.action}`, { status: 202 });
  }

  const repository = await activeRepository(payload.installation?.id, payload.repository?.id);
  if (!repository) {
    // Suspended, uninstalled, or a repository the installation no longer covers. A signed
    // delivery for one of those is still a delivery we refuse to act on.
    return new Response("repository is not connected", { status: 202 });
  }

  const { disposition } = await enqueue({ channel: "github", deliveryId, payload });

  return new Response(disposition, { status: 202 });
}

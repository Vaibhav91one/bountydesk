import { hasValidWorkerAuthorization } from "@/lib/internal/worker-auth";
import { reconcileGitHubAccess } from "@/lib/github/reconcile";

// signAppJwt (node:crypto) and a Postgres socket both need the Node runtime.
export const runtime = "nodejs";

const MAX_TICK_MS = 20_000;

/**
 * The reconcile backstop for GitHub access revocation, on demand. The worker daemon runs it every
 * 15 minutes (scripts/run-worker-daemon.ts); this route is the bearer-guarded manual trigger. It is
 * idempotent and cheap: one read of GitHub's current installations, then per still-live
 * installation its repository set, revoking only what the lifecycle webhooks missed.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasValidWorkerAuthorization(request.headers.get("authorization"))) {
    return new Response("unauthorized", { status: 401 });
  }

  const signal = AbortSignal.timeout(MAX_TICK_MS);
  const summary = await reconcileGitHubAccess({ signal });
  // Errors are non-fatal read failures that left some grants unchecked; a 200 with the list lets a
  // scheduler log them without treating the whole tick as failed.
  return Response.json(summary);
}

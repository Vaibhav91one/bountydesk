import { and, db, eq } from "@/lib/db";
import { devicePushToken } from "@/lib/db/schema";
import { jsonError, mobileAuth } from "@/lib/mobile/auth";

export const runtime = "nodejs";

const TOKEN_RE = /^ExponentPushToken\[[A-Za-z0-9_-]+\]$/;

type RegisterBody = { token: string; platform: string };
type TokenBody = { token: string };

/** Register or refresh a push token for the signed-in reviewer. */
export async function POST(request: Request): Promise<Response> {
  const gate = await mobileAuth();
  if (!gate.ok) return gate.response;

  const body = await parseRegisterBody(request);
  if (!body) return jsonError("invalid body", 400);

  const { token, platform } = body;
  if (!TOKEN_RE.test(token) || token.length > 200) {
    return jsonError("invalid token", 400);
  }
  if (platform !== "ios" && platform !== "android") {
    return jsonError("invalid platform", 400);
  }

  await db
    .insert(devicePushToken)
    .values({
      token,
      reviewerEmail: gate.session.email,
      platform,
      lastSeenAt: new Date(),
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: devicePushToken.token,
      set: {
        reviewerEmail: gate.session.email,
        platform,
        lastSeenAt: new Date(),
        revokedAt: null,
      },
    });

  return Response.json({ ok: true });
}

/** Revoke the reviewer's own token. A token the reviewer does not own is a 404. */
export async function DELETE(request: Request): Promise<Response> {
  const gate = await mobileAuth();
  if (!gate.ok) return gate.response;

  const body = await parseTokenBody(request);
  if (!body) return jsonError("invalid body", 400);

  const { token } = body;
  if (!TOKEN_RE.test(token)) {
    return jsonError("invalid token", 400);
  }

  const result = await db
    .update(devicePushToken)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(devicePushToken.token, token), eq(devicePushToken.reviewerEmail, gate.session.email)),
    );

  if (result.count === 0) return jsonError("not found", 404);
  return new Response(null, { status: 204 });
}

async function parseRegisterBody(request: Request): Promise<RegisterBody | null> {
  const parsed = await parseBody(request);
  if (!parsed) return null;
  const { token, platform } = parsed;
  if (typeof token !== "string" || typeof platform !== "string") return null;
  return { token, platform };
}

async function parseTokenBody(request: Request): Promise<TokenBody | null> {
  const parsed = await parseBody(request);
  if (!parsed) return null;
  const { token } = parsed;
  if (typeof token !== "string") return null;
  return { token };
}

async function parseBody(request: Request): Promise<{ token?: unknown; platform?: unknown } | null> {
  let jsonBody: unknown;
  try {
    jsonBody = await request.json();
  } catch {
    return null;
  }
  if (typeof jsonBody !== "object" || jsonBody === null) return null;
  return jsonBody as { token?: unknown; platform?: unknown };
}

import { assetLinks } from "@/lib/mobile/universal-links";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const body = assetLinks();
  if (!body) return new Response(null, { status: 404 });

  return Response.json(body, { headers: { "cache-control": "public, max-age=3600" } });
}

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json(
    {
      ok: true,
      service: "bountydesk-web",
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}

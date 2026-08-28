export function buildMcpServerManifest(appBaseUrl: string, secret: string) {
  return {
    name: "bountydesk",
    description: "BountyDesk's publish_verdict approval gate",
    type: "remote" as const,
    url: `${appBaseUrl}/api/mcp/publish-verdict`,
    auth: {
      type: "header" as const,
      headers: { Authorization: `Bearer ${secret}` },
    },
  };
}

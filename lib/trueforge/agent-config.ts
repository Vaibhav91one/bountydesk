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

/**
 * The scope-guard connector: full tool surface (scope_check, http_probe, tcp_probe,
 * scope_add/remove/add_temporary, request_intrusive_approval, verify_grant, osv_query,
 * osv_get, scope_list, audit_read, policy_get) at app/api/mcp/scope-guard/route.ts.
 *
 * No agent manifest references this connector yet: the reproduction agent that would call
 * these tools during a sandbox run isn't built (see AGENTS.md - "None of the sandbox work is
 * built yet"). Registering the connector now, ahead of that agent, is what lets
 * `requireApprovalForTools` land in the same manifest edit that wires the agent to it later,
 * rather than as a follow-up someone has to remember.
 */
export function buildScopeGuardServerManifest(scopeGuardUrl: string, token: string) {
  return {
    name: "scope-guard",
    description: "BountyDesk's ported scope-guard MCP server: egress allowlisting and the intrusive-action approval gate",
    type: "remote" as const,
    url: `${scopeGuardUrl}/api/mcp/scope-guard`,
    auth: {
      type: "header" as const,
      headers: { Authorization: `Bearer ${token}` },
    },
  };
}

/**
 * The four tools that must never run without a human clicking Allow in TrueForge first.
 * Whatever agent manifest eventually lists the scope-guard connector should set
 * `requireApprovalForTools` to this, the same way bountydesk.agent.json does for
 * publish_verdict - see AGENTS.md's hardening notes on advisory-only enforcement.
 */
export const SCOPE_GUARD_APPROVAL_GATED_TOOLS = [
  "request_intrusive_approval",
  "scope_add",
  "scope_remove",
  "scope_add_temporary",
] as const;

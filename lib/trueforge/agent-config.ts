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

/** The onboarding agent's build tools: open a build sandbox, run build commands, commit a recipe or
 *  declare a repo unsandboxable. Authenticated with the same MCP server secret; the route resolves
 *  the calling onboarding row by the agent's capability token. */
export function buildBuildServerManifest(appBaseUrl: string, secret: string) {
  return {
    name: "bountydesk-build",
    description: "BountyDesk's onboarding build sandbox",
    type: "remote" as const,
    url: `${appBaseUrl}/api/mcp/build`,
    auth: {
      type: "header" as const,
      headers: { Authorization: `Bearer ${secret}` },
    },
  };
}

/**
 * The onboarding agent's build tools carry no harness approval gate, on purpose. The onboarding turn
 * is driven by a synchronous poll (lib/build-onboarding/onboarding-agent.ts) that treats an approval
 * pause as a wiring error, and it cannot resolve one; and the human gate that matters already exists
 * one level up, at the onboarding AWAITING_APPROVAL step, where a reviewer approves the built target
 * before it becomes a TargetProfile. The build sandbox is ephemeral with server-held egress, and the
 * committed image is rebuilt and offline-verified, so per-command gating would add friction without a
 * boundary the onboarding approval does not already provide.
 */
export const BUILD_APPROVAL_GATED_TOOLS = [] as const;

/**
 * The scope-guard connector: full tool surface (scope_check, http_probe, tcp_probe,
 * scope_add/remove/add_temporary, request_intrusive_approval, verify_grant, osv_query,
 * osv_get, scope_list, audit_read, policy_get) at app/api/mcp/scope-guard/route.ts.
 *
 * `agent/bountydesk.agent.json` references this connector today, with
 * `requireApprovalForTools` set from the exported `SCOPE_GUARD_APPROVAL_GATED_TOOLS` below.
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
 * `agent/bountydesk.agent.json`'s scope-guard connector sets `requireApprovalForTools` to
 * this, the same way it does for `publish_verdict` - see AGENTS.md's hardening notes on
 * advisory-only enforcement.
 */
export const SCOPE_GUARD_APPROVAL_GATED_TOOLS = [
  "request_intrusive_approval",
  "scope_add",
  "scope_remove",
  "scope_add_temporary",
] as const;

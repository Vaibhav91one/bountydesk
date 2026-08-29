import { timingSafeEqual } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { scopeGuardToken } from "@/lib/env";
import * as audit from "@/lib/scope-guard/audit";
import { httpProbe, tcpProbe } from "@/lib/scope-guard/egress";
import * as grants from "@/lib/scope-guard/grants";
import { isLoopbackTarget, normalizeTargetValue } from "@/lib/scope-guard/scope";
import { withScope } from "@/lib/scope-guard/scope-profile";

// node:crypto and the Postgres connections this route opens (scope, audit, grants) all need
// the Node runtime, same reasoning as the publish-verdict route.
export const runtime = "nodejs";

const NAME = "bountydesk-scope-guard";
const VERSION = "1.0.0";

/** Every call that reaches a tool handler has already presented the bearer secret, so unlike
 * Sentinel's optional GUARD_TOKEN this is never "open-local" - see isAuthorized() below. */
const AUTH_MODE = "bearer-verified";

/** Same shape as publish-verdict's isAuthorized(): compare lengths before timingSafeEqual,
 * since the function throws on a length mismatch rather than returning false. */
function isAuthorized(header: string | null): boolean {
  if (!header) return false;
  const expected = Buffer.from(`Bearer ${scopeGuardToken()}`);
  const received = Buffer.from(header);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

function text(result: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: NAME, version: VERSION });

  server.registerTool(
    "scope_check",
    {
      title: "Scope check",
      description:
        "MUST be called before any network contact with a target. Returns whether the host is inside the authorized scan scope. Every call is written to an append-only audit log.",
      inputSchema: { target: z.string().describe("Host, URL or IP to check, e.g. http://localhost:3000") },
      annotations: { readOnlyHint: true },
    },
    async ({ target }) => {
      const verdict = await withScope(false, (scope) => scope.check(target));
      await audit.append({
        actor: "agent",
        auth: AUTH_MODE,
        action: "scope_check",
        args: { target },
        verdict: verdict.allowed ? "allowed" : "denied",
        reason: verdict.reason,
      });
      return text(verdict);
    },
  );

  server.registerTool(
    "http_probe",
    {
      title: "Scoped HTTP relay (black-box transport)",
      description:
        "Host-side HTTP transport for BLACK-BOX targets the sandbox cannot reach (restricted egress). "
        + "The request executes on the HOST after mandatory scope validation, and the connection is pinned to the "
        + "exact address just validated (not a fresh DNS lookup) so a rebinding attempt between the check and the "
        + "connect cannot land. HTTP/HTTPS GET/POST/HEAD/OPTIONS only; redirects are RETURNED (not followed - "
        + "re-probe the Location URL so each hop is re-scoped); response bodies capped at 32 KB; no raw TCP, no "
        + "port scanning. For deep exploitation continue inside the sandbox lab.",
      inputSchema: {
        url: z.string().describe("Absolute http(s) URL to probe"),
        method: z.enum(["GET", "POST", "HEAD", "OPTIONS"]).default("GET").optional(),
        headers: z.record(z.string(), z.string()).optional().describe("Extra request headers"),
        body: z.string().max(16384).optional().describe("Request body (POST only)"),
        timeout_seconds: z.number().int().min(3).max(30).optional().describe("Default 15"),
        grant_token: z.string().optional().describe("A SCOPE_GUARD_GRANT value from verify_grant, if this probe is part of an approved intrusive action"),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ url, method, headers, body, timeout_seconds, grant_token }) => {
      const result = await withScope(false, (scope) =>
        httpProbe(scope, {
          url,
          method,
          headers,
          body,
          timeoutSeconds: timeout_seconds,
          grantToken: grant_token,
        }),
      );
      await audit.append({
        actor: "agent",
        auth: AUTH_MODE,
        action: "http_probe",
        args: { url, method: method ?? "GET" },
        verdict: result.probed ? "allowed" : "denied",
        reason: result.probed ? `HTTP ${result.status} in ${result.elapsed_ms}ms` : (result.error ?? "denied"),
      });
      return text(result);
    },
  );

  server.registerTool(
    "tcp_probe",
    {
      title: "Scoped raw TCP relay (non-HTTP transport)",
      description:
        "Host-side raw TCP transport for protocols http_probe can't reach (SMTP, Redis, raw sockets, etc.) - single "
        + "connect, optional write, capped read, then close, pinned to the exact address scope_check validated. "
        + "This is a connect+send+recv PRIMITIVE, not a port scanner - one call touches one host:port. Response "
        + "bytes capped at 32 KB and returned as UTF-8 (best-effort) plus base64 (exact bytes). Use nmap inside "
        + "the sandbox for port sweeps.",
      inputSchema: {
        host: z.string().describe("Target hostname or IP (no scheme)"),
        port: z.number().int().min(1).max(65535),
        data_base64: z.string().optional().describe("Bytes to write after connecting, base64-encoded"),
        timeout_seconds: z.number().int().min(1).max(20).optional().describe("Default 8"),
        grant_token: z.string().optional().describe("A SCOPE_GUARD_GRANT value from verify_grant, if this probe is part of an approved intrusive action"),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ host, port, data_base64, timeout_seconds, grant_token }) => {
      const result = await withScope(false, (scope) =>
        tcpProbe(scope, { host, port, dataBase64: data_base64, timeoutSeconds: timeout_seconds, grantToken: grant_token }),
      );
      await audit.append({
        actor: "agent",
        auth: AUTH_MODE,
        action: "tcp_probe",
        args: { host, port, wrote_bytes: data_base64 ? Buffer.from(data_base64, "base64").length : 0 },
        verdict: result.probed ? "allowed" : "denied",
        reason: result.probed ? `${result.bytes_read} bytes in ${result.elapsed_ms}ms` : (result.error ?? "denied"),
      });
      return text(result);
    },
  );

  server.registerTool(
    "scope_add_temporary",
    {
      title: "Add temporary bootstrap scope",
      description:
        "Add a SELF-EXPIRING public-host entry for lab/bootstrap plumbing (package repos, CDNs, download hosts). "
        + "Caps: max 5 live entries, TTL <= 60 minutes, public class only. Gated by the harness's own "
        + "human-approval checkpoint before this call executes, same as scope_add/scope_remove.",
      inputSchema: {
        entry: z.string().describe("Public hostname to authorize temporarily"),
        ttl_minutes: z.number().int().min(1).max(60).optional().describe("Lifetime in minutes (default 30)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ entry, ttl_minutes }) => {
      const ttl = ttl_minutes ?? 30;
      const { error, allow, temporary } = await withScope(true, async (scope) => {
        const err = await scope.addTemporary(entry, ttl);
        return { error: err, allow: scope.list(), temporary: scope.temporaryList() };
      });
      await audit.append({
        actor: "human-via-agent",
        auth: AUTH_MODE,
        action: "scope_add_temporary",
        args: { entry, ttl_minutes: ttl },
        verdict: error ? "denied" : "mutated",
        reason: error ?? `temporary entry added (${ttl} min)`,
      });
      return text(error === null ? { added: entry, expires_in_minutes: ttl, allow, temporary } : { error });
    },
  );

  server.registerTool(
    "scope_add",
    {
      title: "Add scope entry",
      description:
        "Authorize a target by adding it to the allowlist. Accepts hostname[:port], IP, CIDR or *.domain wildcard. "
        + "Cloud metadata endpoints are refused. Gated by the harness's own human-approval checkpoint before this "
        + "call executes.",
      inputSchema: { entry: z.string().describe("Scope entry to add") },
      annotations: { destructiveHint: true },
    },
    async ({ entry }) => {
      const { error, allow } = await withScope(true, async (scope) => {
        const err = await scope.add(entry);
        return { error: err, allow: scope.list() };
      });
      await audit.append({
        actor: "human-via-agent",
        auth: AUTH_MODE,
        action: "scope_add",
        args: { entry },
        verdict: error ? "denied" : "mutated",
        reason: error ?? "entry added",
      });
      return text(error === null ? { added: entry, allow } : { error });
    },
  );

  server.registerTool(
    "scope_remove",
    {
      title: "Remove scope entry",
      description:
        "Remove a target from the allowlist. Gated by the harness's own human-approval checkpoint before this "
        + "call executes.",
      inputSchema: { entry: z.string().describe("Exact scope entry to remove") },
      annotations: { destructiveHint: true },
    },
    async ({ entry }) => {
      const { removed, allow } = await withScope(true, async (scope) => {
        const r = await scope.remove(entry);
        return { removed: r, allow: scope.list() };
      });
      await audit.append({
        actor: "human-via-agent",
        auth: AUTH_MODE,
        action: "scope_remove",
        args: { entry },
        verdict: removed ? "mutated" : "denied",
        reason: removed ? "entry removed" : "entry not found",
      });
      return text({ removed, allow });
    },
  );

  server.registerTool(
    "request_intrusive_approval",
    {
      title: "Request intrusive-scan approval",
      description:
        "Call BEFORE any active/intrusive action against a target (port scans, exploit probes, brute force, "
        + "fuzzing). The harness's requireApprovalForTools gate pauses this call for explicit human Allow/Deny "
        + "before it ever reaches this handler - by the time this code runs, a human has already approved it. On "
        + "approval the guard re-verifies the target is in scope and mints a single-use grant, stored in Postgres "
        + "and consumed transactionally by verify_grant (embed as SCOPE_GUARD_GRANT=<token>). http_probe and "
        + "tcp_probe both accept and enforce this token at the moment they connect, closing the gap Sentinel's "
        + "version left as consent bookkeeping only.",
      inputSchema: {
        target: z.string().describe("The exact target the intrusive action will touch"),
        action: z.string().describe("Short label of the action, e.g. 'nmap full port sweep'"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ target, action }) => {
      const verdict = await withScope(false, (scope) => scope.check(target));
      if (!verdict.allowed) {
        await audit.append({
          actor: "agent",
          auth: AUTH_MODE,
          action: "intrusive_request",
          args: { target, action },
          verdict: "denied",
          reason: `out-of-scope target refused before human review: ${verdict.reason}`,
        });
        return text({ approved: false, grant_token: null, reason: verdict.reason });
      }
      const canonicalTarget = normalizeTargetValue(target) ?? target;
      const grant = await grants.mint(canonicalTarget, action);
      const ttlMin = Math.round((grant.expiresAt.getTime() - Date.now()) / 60000);
      await audit.append({
        actor: "human-via-agent",
        auth: AUTH_MODE,
        action: "intrusive_request",
        // fingerprint only - audit_read must never expose redeemable grant material
        args: { target: canonicalTarget, action, grant: `${grant.token.slice(0, 8)}...`, loopback: isLoopbackTarget(canonicalTarget) },
        verdict: "allowed",
        reason: `human Allow/Deny enforced by the harness's requireApprovalForTools gate on this call; in-scope re-verified, single-use grant minted (${ttlMin} min)`,
      });
      return text({
        approved: true,
        grant_token: grant.token,
        expires_in_minutes: ttlMin,
        note: "single-use; embed as SCOPE_GUARD_GRANT=<token> and pass as grant_token to http_probe/tcp_probe, or confirm separately with verify_grant",
      });
    },
  );

  server.registerTool(
    "verify_grant",
    {
      title: "Verify intrusive-scan grant",
      description:
        "Consumes a single-use grant token for a target. Returns valid:false on reuse, expiry, or target mismatch "
        + "(host[:port] scope - scheme/path are not part of the binding). Consumption is transactional in "
        + "Postgres: two racing verify_grant calls for the same token cannot both succeed.",
      inputSchema: {
        token: z.string().describe("The SCOPE_GUARD_GRANT value returned by request_intrusive_approval"),
        target: z.string().describe("The exact target the grant was issued for"),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ token, target }) => {
      const requested = normalizeTargetValue(target) ?? target;
      const result = await grants.verify(token, requested);
      await audit.append({
        actor: "agent",
        auth: AUTH_MODE,
        action: "grant_verify",
        args: { target: requested, token: `${token.slice(0, 8)}...` },
        verdict: result.valid ? "allowed" : "denied",
        reason: result.reason,
      });
      return text({ ...result, bound_target: requested });
    },
  );

  server.registerTool(
    "osv_query",
    {
      title: "Query OSV for package vulnerabilities",
      description:
        "Runs host-side (the sandbox has restricted egress). Query OSV.dev for known vulnerabilities affecting a package version.",
      inputSchema: {
        name: z.string().describe("Package name, e.g. express"),
        ecosystem: z.string().describe("OSV ecosystem, e.g. npm, PyPI, Go"),
        version: z.string().optional().describe("Version string when known"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name, ecosystem, version }) => {
      const body: Record<string, unknown> = { package: { name, ecosystem } };
      if (version) body.version = version;
      try {
        const res = await fetch("https://api.osv.dev/v1/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
        });
        const d = (await res.json()) as { vulns?: unknown[] };
        await audit.append({
          actor: "agent",
          auth: AUTH_MODE,
          action: "osv_query",
          args: { name, ecosystem, version },
          verdict: "allowed",
          reason: `${(d.vulns ?? []).length} advisories`,
        });
        return text({ count: d.vulns?.length ?? 0, vulns: d.vulns ?? [] });
      } catch (err) {
        return text({ error: `osv query failed: ${(err as Error).message}` });
      }
    },
  );

  server.registerTool(
    "osv_get",
    {
      title: "Fetch one OSV advisory",
      description: "Host-side. Fetch full details (severity, affected ranges, references) for an OSV id such as GHSA-xxxx or CVE-xxxx.",
      inputSchema: { id: z.string().describe("OSV/GHSA/CVE id") },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      try {
        const res = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, {
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) return text({ error: `HTTP ${res.status}`, found: false });
        const d = (await res.json()) as Record<string, unknown>;
        return text({
          id: d.id,
          summary: d.summary,
          details: typeof d.details === "string" ? d.details.slice(0, 1500) : d.details,
          severity: d.severity ?? (d.database_specific as Record<string, unknown> | undefined)?.severity,
          aliases: d.aliases,
          affected_count: Array.isArray(d.affected) ? d.affected.length : 0,
          references: Array.isArray(d.references) ? d.references.slice(0, 8) : [],
        });
      } catch (err) {
        return text({ error: `osv fetch failed: ${(err as Error).message}` });
      }
    },
  );

  server.registerTool(
    "scope_list",
    {
      title: "List scope",
      description: "Return the current authorized-target allowlist.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const result = await withScope(false, (scope) => ({ allow: scope.list(), temporary: scope.temporaryList() }));
      return text(result);
    },
  );

  server.registerTool(
    "audit_read",
    {
      title: "Read audit log",
      description: "Return the last N entries of the append-only scope audit log, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(500).default(25).optional().describe("How many entries (default 25)") },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => text({ entries: await audit.read(limit ?? 25) }),
  );

  server.registerTool(
    "policy_get",
    {
      title: "Get policy",
      description: "Explain the scope-guard authorization policy and report current scope size.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const allowSize = await withScope(false, (scope) => scope.list().length);
      return text({
        rules: [
          "every outbound contact requires a prior allowed scope_check",
          "http_probe/tcp_probe connect to the exact address scope_check validated, not a fresh DNS lookup - the DNS-rebinding TOCTOU window Sentinel left as a roadmap item is closed by default here",
          "lab-bootstrap hosts may be added via scope_add_temporary (public only, max 5, self-expiring <=60min); it is gated by the harness's human-approval checkpoint exactly like scope_add/scope_remove, tighter than Sentinel's autonomous version",
          "public-scoped hostnames are DNS-resolved at check time; resolution into private/link-local space is denied as a rebinding attempt",
          "cloud metadata endpoints (169.254.169.254, metadata.google.internal) are hard-denied, including by DNS resolution",
          "link-local space is hard-denied, including CIDR entries that overlap it",
          "intrusive actions: the harness pauses request_intrusive_approval for a human Allow/Deny before it executes; the minted grant is stored in Postgres and consumed transactionally, target-bound and single-use",
          "scope_add/scope_remove/scope_add_temporary/request_intrusive_approval are gated by the harness's requireApprovalForTools mechanism; every mcp call also requires the SCOPE_GUARD_TOKEN bearer secret",
          "all decisions land in the append-only, hash-chained audit log (audit_read)",
        ],
        allow_size: allowSize,
      });
    },
  );

  return server;
}

/**
 * Stateless MCP endpoint: a fresh server and transport per call, matching publish-verdict.
 * Nothing here holds state across requests - scope, audit and grants each own their own
 * Postgres reads/writes per call.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request.headers.get("authorization"))) {
    return new Response("unauthorized", { status: 401 });
  }

  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
  }
}

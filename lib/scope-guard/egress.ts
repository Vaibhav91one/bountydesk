import { request as httpRequestNode, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequestNode } from "node:https";
import { connect as tcpConnect } from "node:net";

import * as grants from "./grants";
import { normalizeTargetValue, splitHostPort, type Scope } from "./scope";

/**
 * The connect-time egress path for `http_probe`/`tcp_probe`, ported from Sentinel's opt-in
 * egress proxy (`mcp/scope-guard/src/index.ts`, gated behind `EGRESS_PROXY_PORT`) and made the
 * only path these two tools use - there is no unguarded fallback to plain `fetch`/`net.connect`.
 *
 * Sentinel's own SECURITY.md is explicit about the gap this closes: `scope_check` resolves a
 * hostname once to decide if it's in bounds, but a tool that then calls `fetch()` or
 * `net.connect()` on the same hostname triggers a *second*, independent DNS lookup. Nothing
 * stops those two lookups from disagreeing - an attacker controlling DNS can answer the first
 * one safely and the second one with a private/metadata address, and the check never sees the
 * address the connection actually uses. `Scope.check()` now returns `connectAddress`, the
 * exact address it validated; `authorizeConnect` below is what makes every caller dial that
 * address instead of asking the hostname again, with the original hostname preserved only for
 * the HTTP Host header / TLS SNI+certificate check, exactly the way `curl --resolve` pins a
 * name to an address without giving up certificate validation.
 */

export interface Authorization {
  ok: boolean;
  reason: string;
  host: string;
  port: number;
  /** The address to actually dial. Only present when ok is true. */
  connectAddress: string;
}

function defaultPort(scheme: "http" | "https"): number {
  return scheme === "https" ? 443 : 80;
}

/**
 * Runs a fresh scope check (and, if a grant token is presented, consumes it) and returns the
 * pinned address to connect to. This is the single choke point both http_probe and tcp_probe
 * call immediately before opening a socket - "immediately before" is what keeps the check and
 * the connect from drifting apart in time the way scope_check-then-fetch-later would.
 */
export async function authorizeConnect(
  scope: Scope,
  target: string,
  grantToken?: string,
): Promise<Authorization> {
  const verdict = await scope.check(target);
  if (!verdict.allowed || !verdict.connectAddress) {
    return { ok: false, reason: `scope denial: ${verdict.reason}`, host: "", port: 0, connectAddress: "" };
  }
  if (grantToken) {
    const canonical = normalizeTargetValue(target) ?? target;
    const g = await grants.verify(grantToken, canonical);
    if (!g.valid) {
      return { ok: false, reason: `grant denial: ${g.reason}`, host: "", port: 0, connectAddress: "" };
    }
  }
  const normalized = normalizeTargetValue(target) ?? target;
  const { host, port } = splitHostPort(normalized);
  return {
    ok: true,
    reason: grantToken ? "scope + grant verified at connect time" : "scope verified at connect time",
    host,
    port: port ? Number(port) : 0,
    connectAddress: verdict.connectAddress,
  };
}

export interface HttpProbeInput {
  url: string;
  method?: "GET" | "POST" | "HEAD" | "OPTIONS";
  headers?: Record<string, string>;
  body?: string;
  timeoutSeconds?: number;
  grantToken?: string;
}

/** Field names are snake_case (not this file's usual camelCase) to keep the tool's on-the-wire
 * JSON identical to Sentinel's original http_probe/tcp_probe response shape. */
export interface HttpProbeResult {
  probed: boolean;
  error?: string;
  status?: number;
  location?: string | null;
  headers?: Record<string, string>;
  body_bytes?: number;
  body_preview?: string;
  truncated?: boolean;
  elapsed_ms?: number;
  note?: string;
}

const BODY_CAP = 32_768;

/**
 * Host-side HTTP transport, connection pinned to the address scope.check() just validated.
 * Redirects are returned, not followed: each hop needs its own fresh scope_check + connect
 * (a redirect target is caller-controlled input, exactly the shape scope-guard exists for).
 */
export async function httpProbe(scope: Scope, input: HttpProbeInput): Promise<HttpProbeResult> {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { probed: false, error: "invalid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { probed: false, error: "only http/https schemes allowed" };
  }

  const auth = await authorizeConnect(scope, input.url, input.grantToken);
  if (!auth.ok) return { probed: false, error: auth.reason };

  const scheme = parsed.protocol === "https:" ? "https" : "http";
  const port = parsed.port ? Number(parsed.port) : defaultPort(scheme);
  const method = (input.method ?? "GET").toUpperCase();
  const started = Date.now();

  // The outbound request's authority must come from the URL the scope check just validated,
  // never from a caller-supplied header: a Host override would let a request that's pinned to
  // an allowed IP still be routed, at the virtual-host layer, to whatever out-of-scope name the
  // caller puts in that header - the same class of gap connectAddress-pinning closes at the
  // socket layer. Strip it case-insensitively before merging in the rest of the caller's headers.
  const callerHeaders = Object.fromEntries(
    Object.entries(input.headers ?? {}).filter(([key]) => key.toLowerCase() !== "host"),
  );
  const hostHeader = port === defaultPort(scheme) ? parsed.hostname : `${parsed.hostname}:${port}`;

  return new Promise<HttpProbeResult>((resolve) => {
    // Dial the address the scope check pinned, not a fresh lookup of parsed.hostname. The two
    // branches exist (rather than one call through a shared function reference) because
    // node:https' RequestOptions carries TLS fields (servername, rejectUnauthorized) that
    // node:http's does not, and https-only options that node:http would happily ignore at
    // runtime are still worth keeping out of the type both branches would otherwise share.
    const commonOptions = {
      host: auth.connectAddress,
      port,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      timeout: (input.timeoutSeconds ?? 15) * 1000,
      // host last: nothing after it in this object literal can re-override the authority.
      headers: { "user-agent": "BountyDesk-ScopeGuard/1.0", ...callerHeaders, host: hostHeader },
    };
    const onResponse = (res: IncomingMessage): void => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (Buffer.concat(chunks).length < BODY_CAP) chunks.push(chunk);
      });
      res.on("end", () => {
        const buf = Buffer.concat(chunks).subarray(0, BODY_CAP);
        const ms = Date.now() - started;
        const hdrs: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") hdrs[k] = v;
          else if (Array.isArray(v)) hdrs[k] = v.join(", ");
        }
        resolve({
          probed: true,
          status: res.statusCode,
          location: typeof res.headers.location === "string" ? res.headers.location : null,
          headers: hdrs,
          body_bytes: total,
          body_preview: buf.toString("utf8"),
          truncated: total > BODY_CAP,
          elapsed_ms: ms,
          note:
            (res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400
              ? "redirect returned unfollowed - scope_check the Location target before continuing"
              : undefined,
        });
      });
    };

    const req: ClientRequest =
      scheme === "https"
        ? httpsRequestNode({ ...commonOptions, servername: parsed.hostname, rejectUnauthorized: true }, onResponse)
        : httpRequestNode(commonOptions, onResponse);

    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", (err) => resolve({ probed: false, error: `transport failure: ${err.message}` }));
    if (method === "POST" && input.body !== undefined) req.write(input.body);
    req.end();
  });
}

export interface TcpProbeInput {
  host: string;
  port: number;
  dataBase64?: string;
  timeoutSeconds?: number;
  grantToken?: string;
}

export interface TcpProbeResult {
  probed: boolean;
  error?: string;
  bytes_read?: number;
  body_preview_utf8?: string;
  body_base64?: string;
  truncated?: boolean;
  elapsed_ms?: number;
  note?: string;
}

/**
 * Host-side raw TCP transport for protocols httpProbe can't reach. One connect, optional
 * write, capped read, then close - a connect+send+recv primitive, not a port scanner.
 */
export async function tcpProbe(scope: Scope, input: TcpProbeInput): Promise<TcpProbeResult> {
  // A bare IPv6 host needs brackets before ":port" is appended, or the result ("::1:6379") is
  // ambiguous between "host ::1:6379" and "host ::1, port 6379" - scope.check() parses this
  // string as a URL, and an unbracketed IPv6-with-port URL authority doesn't parse at all.
  const isBareIPv6 = input.host.includes(":") && !input.host.startsWith("[");
  const target = `${isBareIPv6 ? `[${input.host}]` : input.host}:${input.port}`;
  const auth = await authorizeConnect(scope, target, input.grantToken);
  if (!auth.ok) return { probed: false, error: auth.reason };

  const timeoutMs = (input.timeoutSeconds ?? 8) * 1000;
  const started = Date.now();

  return new Promise<TcpProbeResult>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const CAP = 32_768;
    let settled = false;
    let connected = false;
    const finish = (ok: boolean, extra: Partial<TcpProbeResult> = {}) => {
      if (settled) return;
      settled = true;
      const buf = Buffer.concat(chunks, Math.min(total, CAP));
      resolve({
        probed: ok,
        bytes_read: total,
        body_preview_utf8: buf.toString("utf8"),
        body_base64: buf.toString("base64"),
        truncated: total > CAP,
        elapsed_ms: Date.now() - started,
        ...extra,
      });
    };

    // Dial the pinned address; the original hostname has no protocol role for raw TCP the way
    // it does for HTTP's Host header / TLS SNI, so nothing else needs it past this point.
    const sock = tcpConnect({ host: auth.connectAddress, port: input.port, timeout: timeoutMs });
    sock.on("connect", () => {
      connected = true;
      if (input.dataBase64) {
        try {
          sock.write(Buffer.from(input.dataBase64, "base64"));
        } catch {
          /* write failure surfaces via 'error' */
        }
      }
    });
    sock.on("data", (chunk: Buffer) => {
      if (total < CAP) chunks.push(chunk);
      total += chunk.length;
      if (total >= CAP) sock.end();
    });
    sock.on("timeout", () => {
      sock.destroy();
      // A timeout before 'connect' ever fired means the handshake itself never completed
      // (unreachable host, firewalled port) - that's a failed probe, not a successful one that
      // happened to idle out waiting for a reply.
      if (connected) {
        finish(true, { note: "read timeout reached (this is the normal end for a probe with no explicit close)" });
      } else {
        finish(false, { error: "connection timed out before the TCP handshake completed" });
      }
    });
    sock.on("close", () => finish(true));
    sock.on("error", (err) => finish(false, { error: err.message }));
  });
}

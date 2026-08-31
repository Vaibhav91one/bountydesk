import { timingSafeEqual } from "node:crypto";
import http, { createServer } from "node:http";
import https from "node:https";

const upstream = new URL(process.env.TRUEFORGE_UPSTREAM_URL ?? "http://127.0.0.1:8790");
const secret = process.env.TRUEFORGE_API_KEY?.trim();
const port = Number(process.env.TRUEFORGE_PROXY_PORT ?? 8791);
const hosts = (process.env.TRUEFORGE_PROXY_HOSTS ?? process.env.TRUEFORGE_PROXY_HOST ?? "127.0.0.1")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

if (!secret) {
  console.error("TRUEFORGE_API_KEY must be set for the TrueForge proxy");
  process.exit(1);
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("TRUEFORGE_PROXY_PORT must be an integer between 1 and 65535");
  process.exit(1);
}

if (hosts.length === 0) {
  console.error("TRUEFORGE_PROXY_HOSTS must include at least one bind host");
  process.exit(1);
}

// TrueForge is never public. A wildcard binds every interface the container has, including any
// it gains later, so the only addresses accepted are the ones named: loopback, or the private
// address the platform hands the service. There is deliberately no flag to turn this off.
if (hosts.some((host) => host === "0.0.0.0" || host === "::")) {
  console.error("TRUEFORGE_PROXY_HOSTS must contain only loopback or specific private interfaces");
  process.exit(1);
}

const hopByHopHeaders = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function authorized(header) {
  if (!header) return false;

  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function upstreamUrl(path = "/") {
  const target = new URL(path, upstream);
  return target;
}

function requestModule(url) {
  return url.protocol === "https:" ? https : http;
}

function checkUpstream(url) {
  return new Promise((resolve, reject) => {
    const request = requestModule(url).request(
      url,
      { method: "HEAD", timeout: 2500 },
      (response) => {
        response.resume();
        resolve(response.statusCode !== undefined && response.statusCode < 500);
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("upstream health check timed out"));
    });
    request.on("error", reject);
    request.end();
  });
}

function forwardedHeaders(req) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (hopByHopHeaders.has(name.toLowerCase())) continue;
    if (value !== undefined) headers[name] = value;
  }
  headers.host = upstream.host;
  return headers;
}

async function upstreamIsHealthy() {
  try {
    return await checkUpstream(upstreamUrl("/api/v1/docs"));
  } catch {
    return false;
  }
}

async function proxyRequest(req, res) {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (requestUrl.pathname === "/healthz") {
    const healthy = await upstreamIsHealthy();
    res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: healthy }));
    return;
  }

  if (!authorized(req.headers.authorization)) {
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    res.end("unauthorized");
    return;
  }

  const target = upstreamUrl(`${requestUrl.pathname}${requestUrl.search}`);
  await new Promise((resolve, reject) => {
    const upstreamRequest = requestModule(target).request(target, {
      method: req.method,
      headers: forwardedHeaders(req),
    });

    upstreamRequest.on("response", (response) => {
      const headers = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (!hopByHopHeaders.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
      }
      res.writeHead(response.statusCode ?? 502, headers);
      response.pipe(res);
      response.on("end", resolve);
      response.on("error", reject);
    });
    upstreamRequest.on("error", reject);
    req.on("error", reject);
    req.pipe(upstreamRequest);
  });
}

function createProxyServer() {
  return createServer((req, res) => {
    proxyRequest(req, res).catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("bad gateway");
    });
  });
}

for (const host of hosts) {
  const server = createProxyServer();
  server.listen(port, host, () => {
    console.log(`TrueForge proxy listening on ${host}:${port}`);
  });
}

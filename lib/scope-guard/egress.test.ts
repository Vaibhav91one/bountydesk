import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import test from "node:test";

import { httpProbe, tcpProbe } from "./egress";
import { defaultScopeState, Scope } from "./scope";

/**
 * Deterministic unit tests for the egress transports - no database, no live target other than
 * loopback servers this file spins up itself. lib/scope-guard/scope-profile.ts owns the
 * Postgres-backed Scope; app/api/mcp/scope-guard/route.test.ts covers the route wiring end to
 * end. Every Scope here is the in-memory one, same construction as scope.test.ts.
 */

// defaultScopeState() already allows localhost/127.0.0.1/::1 - the tests below rely on that
// rather than re-adding it, since Scope.add() refuses a duplicate entry.
function makeScope(): Scope {
  return new Scope(defaultScopeState(), undefined, () => {});
}

test("httpProbe sets Host from the validated URL, not a caller-supplied header", async () => {
  const scope = makeScope();

  let seenHost: string | undefined;
  const server: HttpServer = createHttpServer((req, res) => {
    seenHost = req.headers.host;
    res.writeHead(200).end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const result = await httpProbe(scope, {
      url: `http://127.0.0.1:${port}/`,
      headers: { Host: "evil.example" },
    });
    assert.equal(result.probed, true);
    assert.equal(
      seenHost,
      `127.0.0.1:${port}`,
      "Host header must reflect the validated URL's own host:port, not the caller's override",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("httpProbe strips a caller Host header regardless of case", async () => {
  const scope = makeScope();

  let seenHost: string | undefined;
  const server: HttpServer = createHttpServer((req, res) => {
    seenHost = req.headers.host;
    res.writeHead(200).end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const result = await httpProbe(scope, {
      url: `http://127.0.0.1:${port}/`,
      headers: { HOST: "evil.example", "x-marker": "kept" },
    });
    assert.equal(result.probed, true);
    assert.equal(seenHost, `127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("tcpProbe reaches an IPv6 target scoped as a bare address", async () => {
  const server: TcpServer = createTcpServer((socket) => socket.end("hi from v6"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::1", resolve);
  });
  const port = (server.address() as { port: number }).port;

  const scope = makeScope();

  try {
    const result = await tcpProbe(scope, { host: "::1", port });
    assert.equal(result.probed, true);
    assert.match(result.body_preview_utf8 ?? "", /hi from v6/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("tcpProbe reaches an IPv6 target scoped with an explicit bracketed port", async () => {
  const server: TcpServer = createTcpServer((socket) => socket.end("hi from v6, port-scoped"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::1", resolve);
  });
  const port = (server.address() as { port: number }).port;

  const scope = makeScope();
  assert.equal(await scope.add(`[::1]:${port}`), null);

  try {
    const result = await tcpProbe(scope, { host: "::1", port });
    assert.equal(result.probed, true);
    assert.match(result.body_preview_utf8 ?? "", /port-scoped/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("tcpProbe reports a pre-connect timeout as a failed probe, not a successful one", async () => {
  const scope = makeScope();
  // 10.255.255.1 is private (addable) but unrouted in every sandbox this suite runs in, so the
  // TCP handshake never completes and node's own idle timer - not a remote refusal - is what
  // fires first. That's the exact condition this test exists to pin down: a timeout before
  // 'connect' must not be reported the same way as a timeout after a live connection idles out.
  assert.equal(await scope.add("10.255.255.1"), null);

  const result = await tcpProbe(scope, { host: "10.255.255.1", port: 12345, timeoutSeconds: 1 });
  assert.equal(result.probed, false);
  assert.match(result.error ?? "", /handshake/);
});

test("tcpProbe still reports a post-connect idle timeout as successful, with a note", async () => {
  const server: TcpServer = createTcpServer(() => {
    // Accept the connection and never write or close - forces the client to idle out.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const scope = makeScope();

  try {
    const result = await tcpProbe(scope, { host: "127.0.0.1", port, timeoutSeconds: 1 });
    assert.equal(result.probed, true);
    assert.match(result.note ?? "", /read timeout/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

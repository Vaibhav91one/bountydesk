import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import test from "node:test";

import { authorizeConnect, httpProbe, tcpProbe, tcpProbeWithConnect } from "./egress";
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
  const fakeSocket = new EventEmitter() as Socket;
  fakeSocket.destroy = () => fakeSocket;
  fakeSocket.write = (() => true) as Socket["write"];
  fakeSocket.end = (() => fakeSocket) as Socket["end"];

  const result = await tcpProbeWithConnect(scope, { host: "127.0.0.1", port: 12345, timeoutSeconds: 1 }, () => {
    queueMicrotask(() => fakeSocket.emit("timeout"));
    return fakeSocket;
  });
  assert.equal(result.probed, false);
  assert.match(result.error ?? "", /handshake/);
});

test("authorizeConnect requires and verifies a grant for a write action, but never bothers checking one for a passive one", async () => {
  const scope = makeScope();
  let verifyCalls = 0;
  const fakeVerify = async (token: string) => {
    verifyCalls++;
    return token === "good-token"
      ? { valid: true, reason: "ok" }
      : { valid: false, reason: "bad token" };
  };

  const noToken = await authorizeConnect(scope, "127.0.0.1:1", undefined, {
    requiresGrant: true,
    verifyGrantFn: fakeVerify,
  });
  assert.equal(noToken.ok, false);
  assert.match(noToken.reason, /grant denial/);
  assert.equal(verifyCalls, 0, "a missing token is refused outright, never handed to verify");

  const badToken = await authorizeConnect(scope, "127.0.0.1:1", "wrong-token", {
    requiresGrant: true,
    verifyGrantFn: fakeVerify,
  });
  assert.equal(badToken.ok, false);
  assert.match(badToken.reason, /bad token/);

  const goodToken = await authorizeConnect(scope, "127.0.0.1:1", "good-token", {
    requiresGrant: true,
    verifyGrantFn: fakeVerify,
  });
  assert.equal(goodToken.ok, true);

  const passive = await authorizeConnect(scope, "127.0.0.1:1");
  assert.equal(passive.ok, true);
});

test("authorizeConnect never verifies a token on a passive call, so a leftover grant can't be burned before the write it was minted for", async () => {
  const scope = makeScope();
  let verifyCalls = 0;
  const fakeVerify = async () => {
    verifyCalls++;
    return { valid: true, reason: "ok" };
  };

  const result = await authorizeConnect(scope, "127.0.0.1:1", "leftover-token", {
    verifyGrantFn: fakeVerify,
  });
  assert.equal(result.ok, true);
  assert.equal(verifyCalls, 0, "a single-use grant handed to a passive call must survive untouched for the write that actually needs it");
});

test("httpProbe refuses a POST with no grant token before attempting any connection", async () => {
  const scope = makeScope();
  // Port 1 is never listened on in this test, so a "probed: false" result here can only come
  // from the authorization check refusing to dial at all - not from a real connection failure.
  const result = await httpProbe(scope, { url: "http://127.0.0.1:1/", method: "POST", body: "x" });
  assert.equal(result.probed, false);
  assert.match(result.error ?? "", /grant denial/);
});

test("httpProbe still allows a GET with no grant token, since GET is passive", async () => {
  const scope = makeScope();
  const server: HttpServer = createHttpServer((_req, res) => res.writeHead(200).end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const result = await httpProbe(scope, { url: `http://127.0.0.1:${port}/` });
    assert.equal(result.probed, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("tcpProbe refuses to write bytes with no grant token before attempting any connection", async () => {
  const scope = makeScope();
  const result = await tcpProbe(scope, {
    host: "127.0.0.1",
    port: 1,
    dataBase64: Buffer.from("x").toString("base64"),
  });
  assert.equal(result.probed, false);
  assert.match(result.error ?? "", /grant denial/);
});

test("tcpProbe still allows a connect-and-read with no grant token, since it writes nothing", async () => {
  const server: TcpServer = createTcpServer((socket) => socket.end("hi"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  const scope = makeScope();

  try {
    const result = await tcpProbe(scope, { host: "127.0.0.1", port });
    assert.equal(result.probed, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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

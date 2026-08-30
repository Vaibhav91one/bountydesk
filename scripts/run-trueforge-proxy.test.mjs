import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

async function freePort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (typeof address !== "object" || address === null) throw new Error("server did not get a TCP port");
  return address.port;
}

async function startUpstream() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });

    if (req.url === "/api/v1/docs" && req.method === "HEAD") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/api/v1/docs") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("proxied");
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("upstream did not get a TCP port");
  return { server, requests, url: `http://127.0.0.1:${address.port}` };
}

async function waitForProxy(child) {
  let output = "";
  const timeout = AbortSignal.timeout(5000);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      timeout.removeEventListener("abort", onTimeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error(`proxy did not start in time; output: ${output}`));
    };
    const onData = (chunk) => {
      output += String(chunk);
      if (output.includes("TrueForge proxy listening")) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`proxy exited before listening: code ${code}, signal ${signal}, output: ${output}`));
    };

    timeout.addEventListener("abort", onTimeout, { once: true });
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(3000).then(() => child.kill("SIGKILL"))]);
}

test("TrueForge proxy rejects missing and invalid bearer tokens before forwarding", async () => {
  const upstream = await startUpstream();
  const proxyPort = await freePort();
  const child = spawn(process.execPath, ["scripts/run-trueforge-proxy.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TRUEFORGE_API_KEY: "test-secret",
      TRUEFORGE_PROXY_PORT: String(proxyPort),
      TRUEFORGE_UPSTREAM_URL: upstream.url,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForProxy(child);
    const proxyUrl = `http://127.0.0.1:${proxyPort}/api/v1/docs`;

    const missing = await fetch(proxyUrl);
    assert.equal(missing.status, 401);

    const invalid = await fetch(proxyUrl, {
      headers: { authorization: "Bearer wrong-secret" },
    });
    assert.equal(invalid.status, 401);

    assert.equal(
      upstream.requests.filter((request) => request.method !== "HEAD").length,
      0,
      "unauthorized requests must not reach the upstream",
    );
  } finally {
    await stopChild(child);
    await new Promise((resolve, reject) => upstream.server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("TrueForge proxy forwards requests with the configured bearer token", async () => {
  const upstream = await startUpstream();
  const proxyPort = await freePort();
  const child = spawn(process.execPath, ["scripts/run-trueforge-proxy.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TRUEFORGE_API_KEY: "test-secret",
      TRUEFORGE_PROXY_PORT: String(proxyPort),
      TRUEFORGE_UPSTREAM_URL: upstream.url,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForProxy(child);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/v1/docs`, {
      headers: { authorization: "Bearer test-secret" },
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "proxied");
    assert.ok(
      upstream.requests.some(
        (request) =>
          request.method === "GET" &&
          request.url === "/api/v1/docs" &&
          request.authorization === "Bearer test-secret",
      ),
      "authorized requests should be forwarded to the upstream",
    );
  } finally {
    await stopChild(child);
    await new Promise((resolve, reject) => upstream.server.close((error) => (error ? reject(error) : resolve())));
  }
});

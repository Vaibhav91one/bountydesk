/**
 * An in-mesh out-of-band (OOB) HTTP listener peer for confirming SSRF without internet egress.
 *
 * The listener boots in its own reproduction-grade sandbox (`networkBlockAll: true`, `public: false`,
 * torn down in `finally`) link-joined to the target sandbox, so the target can reach it by
 * `http://<listener-sandbox-id>:<port>/<canary>` over the private in-group link route while neither
 * sandbox can reach the internet.
 *
 * The oracle boundary: the target sandbox is untrusted, so we never run `execute()` on the target
 * to ask whether SSRF happened. The listener sandbox is BountyDesk's own isolated peer image
 * (verified by `verifyNoEgress` and `buildMarkerCheck`), and the controller reads the listener's
 * own recorded request log and checks for the run's unpredictable `canary` string on the host side.
 */
import { buildMarkerCheck } from "./build-marker";
import { createSandbox, execute, getSandbox, listSandboxes, type Sandbox } from "./daytona";
import {
  ensureSnapshotActive,
  rethrowIfAborted,
  teardownSandbox,
  throwIfAborted,
  verifyNoEgress,
} from "./provision";

const LISTENER_SANDBOX_TTL_MINUTES = 10;
const DEFAULT_LISTENER_PORT = 8080;
const LOG_PATH = "/tmp/bountydesk-oob.log";
const PID_PATH = "/tmp/bountydesk-oob.pid";
const READY_SENTINEL = "BOUNTYDESK_OOB_LISTENER_READY";
const LOG_BEGIN_SENTINEL = "BOUNTYDESK_OOB_LOG_BEGIN";
const LOG_END_SENTINEL = "BOUNTYDESK_OOB_LOG_END";
const MAX_LOG_CHARS = 100_000;

/**
 * Reuse the browser sandbox image by default when no dedicated listener image env is set, or read
 * dedicated `BOUNTYDESK_OOB_LISTENER_*` vars. Both carry Node.js and a build marker baked into
 * `/etc/bountydesk-build-marker`.
 */
export type OobListenerConfig = {
  snapshotId: string;
  imageRef: string;
  imageName: string;
  expectedBuildMarker: string;
};

const DEFAULT_EXPECTED_MARKER = "browser-out-1";

export function oobListenerConfig(): OobListenerConfig | null {
  const snapshotId = (
    process.env.BOUNTYDESK_OOB_LISTENER_SNAPSHOT ?? process.env.BOUNTYDESK_BROWSER_SNAPSHOT
  )?.trim();
  const imageRef = (
    process.env.BOUNTYDESK_OOB_LISTENER_IMAGE_REF ?? process.env.BOUNTYDESK_BROWSER_IMAGE_REF
  )?.trim();
  const imageName = (
    process.env.BOUNTYDESK_OOB_LISTENER_IMAGE_NAME ?? process.env.BOUNTYDESK_BROWSER_IMAGE_NAME
  )?.trim();
  if (!snapshotId || !imageRef || !imageName) return null;
  // The dedicated listener image carries its own marker; only the shared browser image defaults.
  const dedicatedImage = process.env.BOUNTYDESK_OOB_LISTENER_IMAGE_NAME?.trim();
  const marker = process.env.BOUNTYDESK_OOB_LISTENER_BUILD_MARKER?.trim();
  if (dedicatedImage && !marker) return null;
  return {
    snapshotId,
    imageRef,
    imageName,
    expectedBuildMarker: marker || DEFAULT_EXPECTED_MARKER,
  };
}

function validPort(port: number | undefined): number {
  if (port === undefined) return DEFAULT_LISTENER_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid OOB listener port: ${String(port)}`);
  }
  return port;
}

/**
 * Fixed Node HTTP server script launched inside the listener sandbox. It records every request's
 * method, URL path, and headers as one JSON line in `LOG_PATH` and answers 200 OK. Nothing from a
 * report, recipe, or agent is interpolated into this script.
 */
function startListenerCommand(port: number): string {
  const nodeScript = [
    "const http = require('node:http');",
    "const fs = require('node:fs');",
    `const logPath = '${LOG_PATH}';`,
    "fs.writeFileSync(logPath, '');",
    "const srv = http.createServer((req, res) => {",
    "  const chunks = [];",
    "  req.on('data', (c) => { if (chunks.length < 16) chunks.push(c); });",
    "  req.on('end', () => {",
    "    const entry = JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8').slice(0, 4096) });",
    "    fs.appendFileSync(logPath, entry + '\\n');",
    "    res.writeHead(200, { 'content-type': 'text/plain' });",
    "    res.end('ok');",
    "  });",
    "});",
    `srv.listen(${port}, '0.0.0.0', () => {`,
    `  fs.writeFileSync('${PID_PATH}', String(process.pid));`,
    "  setInterval(() => {}, 60000);",
    "});",
  ].join(" ");
  const encoded = Buffer.from(nodeScript, "utf8").toString("base64");
  return (
    `printf %s '${encoded}' | base64 -d > /tmp/bountydesk-oob-server.js && ` +
    `rm -f ${PID_PATH} ${LOG_PATH} && ` +
    `nohup node /tmp/bountydesk-oob-server.js >/dev/null 2>&1 & ` +
    `for i in $(seq 1 30); do if [ -f ${PID_PATH} ]; then echo ${READY_SENTINEL}; exit 0; fi; sleep 0.1; done; exit 1`
  );
}

const CLEAR_LOG_COMMAND = `: > ${LOG_PATH} && echo BOUNTYDESK_OOB_CLEARED`;
const SNAPSHOT_PATH = "/tmp/bountydesk-oob.snap";
const SAFE_CANARY = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_SETTLE_MS = 1_500;

/**
 * Only lines carrying the canary are returned, so the size cap cannot hide a callback behind junk
 * the target logged first. With `drain`, the log is moved aside and replaced in the same exec, so a
 * callback that lands after the read goes to the fresh log and none is erased unread.
 */
function readLogCommand(canary: string, drain: boolean): string {
  const source = drain ? SNAPSHOT_PATH : LOG_PATH;
  return (
    (drain ? `mv -f ${LOG_PATH} ${SNAPSHOT_PATH} && touch ${LOG_PATH} && ` : "") +
    `echo ${LOG_BEGIN_SENTINEL} && { grep -aF -- '${canary}' ${source} | head -c ${MAX_LOG_CHARS}; true; } && echo "" && echo ${LOG_END_SENTINEL}`
  );
}

function settleMs(): number {
  const raw = Number(process.env.BOUNTYDESK_OOB_SETTLE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SETTLE_MS;
}

function extractLogBody(stdout: string): string | null {
  const start = stdout.indexOf(LOG_BEGIN_SENTINEL);
  if (start === -1) return null;
  const afterStart = start + LOG_BEGIN_SENTINEL.length;
  const end = stdout.indexOf(LOG_END_SENTINEL, afterStart);
  if (end === -1) return null;
  return stdout.slice(afterStart, end);
}

export type OobListenerSession = {
  /** Base URL on the private link network (`http://<listener-sandbox-id>:<port>`). */
  callbackUrl: string;
  /** Reset the recorded request log between the negative control and the exploit leg. */
  clearLog: (signal?: AbortSignal) => Promise<boolean>;
  /**
   * Return true when the listener recorded a request carrying `canary` in its URL, headers, or body.
   * `drain` is for the negative control: wait a settle window for late callbacks, then read and
   * reset the log in one exec so nothing arriving later is erased unread.
   */
  sawCanary: (canary: string, signal?: AbortSignal, opts?: { drain?: boolean }) => Promise<{ ok: true; found: boolean } | { ok: false }>;
  /** Tear down the listener sandbox. */
  close: (cancellationInFlight: boolean) => Promise<void>;
};

export async function startOobListener(
  targetSandboxId: string,
  port?: number,
  opts?: { signal?: AbortSignal },
): Promise<{ ok: true; session: OobListenerSession } | { ok: false; reason: string }> {
  const config = oobListenerConfig();
  if (!config) {
    return { ok: false, reason: "the OOB listener is not configured for this deployment" };
  }
  const listenPort = validPort(port);

  let sandbox: Sandbox | undefined;
  const parentLabel = { "bountydesk.oobListener.parent": targetSandboxId.slice(0, 63) };
  try {
    throwIfAborted(opts?.signal);
    const snapshotInfo = await ensureSnapshotActive(config.snapshotId, "oob listener", opts?.signal);
    throwIfAborted(opts?.signal);
    sandbox = await createSandbox(
      {
        snapshot: config.snapshotId,
        imageRef: config.imageRef,
        cpu: snapshotInfo.cpu ?? 0,
        memoryGb: snapshotInfo.mem ?? 0,
        diskGb: snapshotInfo.disk ?? 0,
        ttlMinutes: LISTENER_SANDBOX_TTL_MINUTES,
        labels: { "bountydesk.purpose.oobListener": "1", ...parentLabel },
      },
      config.imageName,
      { parentSandboxId: targetSandboxId },
    );
    throwIfAborted(opts?.signal);
    sandbox = await getSandbox(sandbox.id);

    await verifyNoEgress(sandbox, opts?.signal);
    throwIfAborted(opts?.signal);

    const markerMatches = await buildMarkerCheck(sandbox, config.expectedBuildMarker);
    throwIfAborted(opts?.signal);
    if (!markerMatches) {
      await teardownSandbox(sandbox.id, false);
      return { ok: false, reason: "the OOB listener sandbox booted the wrong build" };
    }

    const startRes = await execute(sandbox, startListenerCommand(listenPort), 20);
    throwIfAborted(opts?.signal);
    if (startRes.exitCode !== 0 || !startRes.result.includes(READY_SENTINEL)) {
      await teardownSandbox(sandbox.id, false);
      return { ok: false, reason: "the OOB listener failed to start" };
    }

    const activeSandbox = sandbox;
    let closed = false;
    const close = async (cancellationInFlight: boolean): Promise<void> => {
      if (closed) return;
      closed = true;
      await teardownSandbox(activeSandbox.id, cancellationInFlight);
    };

    return {
      ok: true,
      session: {
        callbackUrl: `http://${activeSandbox.id}:${listenPort}`,
        clearLog: async (signal?: AbortSignal): Promise<boolean> => {
          throwIfAborted(signal);
          const cleared = await execute(activeSandbox, CLEAR_LOG_COMMAND, 15);
          throwIfAborted(signal);
          return cleared.exitCode === 0 && cleared.result.includes("BOUNTYDESK_OOB_CLEARED");
        },
        sawCanary: async (
          canary: string,
          signal?: AbortSignal,
          readOpts?: { drain?: boolean },
        ): Promise<{ ok: true; found: boolean } | { ok: false }> => {
          throwIfAborted(signal);
          if (!SAFE_CANARY.test(canary)) return { ok: false };
          const drain = readOpts?.drain === true;
          if (drain) {
            await new Promise((resolve) => setTimeout(resolve, settleMs()));
            throwIfAborted(signal);
          }
          const readRes = await execute(activeSandbox, readLogCommand(canary, drain), 15);
          throwIfAborted(signal);
          if (readRes.exitCode !== 0) return { ok: false };
          const body = extractLogBody(readRes.result);
          if (body === null) return { ok: false };
          return { ok: true, found: body.includes(canary) };
        },
        close,
      },
    };
  } catch (error) {
    if (sandbox) await teardownSandbox(sandbox.id, opts?.signal?.aborted === true);
    else {
      // createSandbox may have created the remote sandbox before throwing, with no id to hand back;
      // sweep this run's listener by label rather than leave it to the TTL. Best effort.
      try {
        for (const orphan of await listSandboxes(parentLabel)) await teardownSandbox(orphan.id, true);
      } catch {
        // the TTL is the backstop
      }
    }
    rethrowIfAborted(error, opts?.signal);
    return {
      ok: false,
      reason: `OOB listener failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

import { randomInt, randomUUID } from "node:crypto";

import {
  NETWORK_PROBES,
  classifyNetworkProbe,
  networkProbeCommand,
  parseNetworkProbeOutput,
  parseToolAvailability,
  readProbeConfig,
  toolCheckCommand,
} from "@/lib/sandbox/capability-probe";
import {
  PURPOSE,
  PURPOSE_LABEL,
  assertSandboxGone,
  createSandbox,
  deleteSandbox,
  execute,
  getSandbox,
  getSnapshot,
  listSandboxes,
  type Sandbox,
  type SnapshotInfo,
} from "@/lib/sandbox/daytona";

const PROBE_LABEL = "bountydesk.capability_probe";
const PROBE_RUN = `capability-${randomUUID()}`;
const LOCAL_PORT = randomInt(31_000, 45_000);
const RUNTIME_PATH = `/tmp/${PROBE_RUN}`;

type Check = {
  name: string;
  status: "PASS" | "FAIL" | "INFO";
  details?: unknown;
};

const checks: Check[] = [];

function record(name: string, status: Check["status"], details?: unknown): void {
  checks.push({ name, status, ...(details === undefined ? {} : { details }) });
  const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  console.log(`${status} ${name}${suffix}`);
}

async function waitForState(id: string, wanted: string[], timeoutMs = 120_000): Promise<Sandbox> {
  const deadline = Date.now() + timeoutMs;
  let last: Sandbox | undefined;

  while (Date.now() < deadline) {
    last = await getSandbox(id);
    if (wanted.includes(last.state)) return last;
    if (["error", "build_failed", "destroyed"].includes(last.state)) {
      throw new Error(`sandbox reached ${last.state} while waiting for ${wanted.join(" or ")}`);
    }
    await delay(3000);
  }

  throw new Error(`timed out waiting for ${wanted.join(" or ")}; last state ${last?.state ?? "unknown"}`);
}

async function sweep(attempts = 1, ignore?: string): Promise<string[]> {
  const labels = { [PROBE_LABEL]: PROBE_RUN, [PURPOSE_LABEL]: PURPOSE };

  for (let attempt = 1; ; attempt++) {
    const stragglers = (await listSandboxes(labels)).filter((sandbox) => sandbox.id !== ignore);
    for (const sandbox of stragglers) await deleteSandbox(sandbox.id);
    if (stragglers.length || attempt === attempts) return stragglers.map((sandbox) => sandbox.id);
    await delay(3000 * attempt);
  }
}

function specLimits(snapshot: SnapshotInfo): { cpu: number; memoryGb: number; diskGb: number } {
  if (snapshot.cpu == null || snapshot.mem == null || snapshot.disk == null) {
    throw new Error(`snapshot ${snapshot.name} does not declare cpu, memory and disk limits`);
  }
  return { cpu: snapshot.cpu, memoryGb: snapshot.mem, diskGb: snapshot.disk };
}

async function verifyTools(sandbox: Sandbox): Promise<void> {
  const result = await execute(sandbox, toolCheckCommand(), 20);
  if (result.exitCode !== 0) throw new Error(`tool check command failed: ${result.result.slice(0, 200)}`);

  const tools = parseToolAvailability(result.result);
  const missing = tools.filter((tool) => !tool.ok).map((tool) => tool.tool);
  record("tools", missing.length ? "FAIL" : "PASS", {
    missing,
    found: tools.filter((tool) => tool.ok).map((tool) => tool.tool),
  });
  if (missing.length) throw new Error(`sandbox is missing required tools: ${missing.join(", ")}`);
}

async function verifyBackgroundAndLocalhost(sandbox: Sandbox): Promise<void> {
  const start = await execute(
    sandbox,
    [
      `mkdir -p ${quote(RUNTIME_PATH)}`,
      `cd ${quote(RUNTIME_PATH)}`,
      "printf 'bountydesk capability probe\\n' > index.html",
      `nohup python3 -m http.server ${LOCAL_PORT} --bind 127.0.0.1 >server.log 2>&1 &`,
      "echo $! > server.pid",
      "sleep 1",
      "pid=$(cat server.pid)",
      "ps -p \"$pid\" >/dev/null 2>&1",
      "printf 'STARTED pid=%s\\n' \"$pid\"",
    ].join("; "),
    20,
  );

  if (start.exitCode !== 0 || !/STARTED pid=\d+/.test(start.result)) {
    throw new Error(`background process did not start: ${start.result.slice(0, 300)}`);
  }
  record("background_start", "PASS");

  let ready = false;
  let last = "";
  for (let attempt = 1; attempt <= 12; attempt++) {
    const result = await execute(
      sandbox,
      `curl -fsS --max-time 2 http://localhost:${LOCAL_PORT}/ | head -c 80`,
      10,
    );
    last = result.result;
    if (result.exitCode === 0 && result.result.includes("bountydesk capability probe")) {
      ready = true;
      break;
    }
    await delay(1000);
  }
  record("localhost_readiness", ready ? "PASS" : "FAIL", { port: LOCAL_PORT });
  if (!ready) throw new Error(`localhost server did not answer on ${LOCAL_PORT}: ${last.slice(0, 200)}`);

  const survival = await execute(
    sandbox,
    [
      `cd ${quote(RUNTIME_PATH)}`,
      "pid=$(cat server.pid)",
      "ps -p \"$pid\" -o pid=,comm= > ps.out 2>&1; ps_code=$?",
      "ss -ltn > ss.out 2>&1; ss_code=$?",
      `grep -E ':${LOCAL_PORT}([[:space:]]|$)' ss.out > ss-match.out 2>&1; grep_code=$?`,
      "printf 'SURVIVAL ps_code=%s ss_code=%s grep_code=%s\\n' \"$ps_code\" \"$ss_code\" \"$grep_code\"",
      "cat ps.out",
      "cat ss-match.out",
    ].join("; "),
    15,
  );
  const parsed = /SURVIVAL ps_code=(\d+) ss_code=(\d+) grep_code=(\d+)/.exec(survival.result);
  const ok = survival.exitCode === 0 && parsed?.[1] === "0" && parsed[2] === "0" && parsed[3] === "0";
  record("background_survival", ok ? "PASS" : "FAIL", { port: LOCAL_PORT });
  if (!ok) throw new Error(`background process did not survive across execute calls: ${survival.result.slice(0, 300)}`);
}

async function cleanupLocalServer(sandbox: Sandbox): Promise<void> {
  const result = await execute(
    sandbox,
    [
      `cd ${quote(RUNTIME_PATH)} 2>/dev/null || exit 0`,
      "pid=$(cat server.pid 2>/dev/null || true)",
      "if [ -n \"$pid\" ]; then kill \"$pid\" 2>/dev/null || true; fi",
      `rm -rf ${quote(RUNTIME_PATH)}`,
      "echo LOCAL_SERVER_CLEANED",
    ].join("; "),
    10,
  ).catch((error) => {
    record("local_server_cleanup", "FAIL", error instanceof Error ? error.message : String(error));
    return null;
  });
  if (result?.result.includes("LOCAL_SERVER_CLEANED")) record("local_server_cleanup", "PASS");
}

async function verifyNoEgressAndMetadata(sandbox: Sandbox): Promise<void> {
  const reached: string[] = [];
  const metadataBlocked: string[] = [];

  for (const probe of NETWORK_PROBES) {
    const result = await execute(sandbox, networkProbeCommand(probe), 20);
    const parsed = parseNetworkProbeOutput(result);
    const classification = classifyNetworkProbe(parsed);
    if (!classification.blocked) reached.push(probe.name);
    if (probe.kind === "metadata" && classification.blocked) metadataBlocked.push(probe.name);

    record(`network_${probe.name}`, classification.blocked ? "PASS" : "FAIL", {
      kind: probe.kind,
      reason: classification.reason,
      curlExit: parsed.curlExit,
      status: parsed.status,
      body: parsed.body ? "<redacted>" : "",
      err: parsed.err.slice(0, 120),
    });
  }

  if (reached.length) throw new Error(`sandbox reached blocked destinations: ${reached.join(", ")}`);

  const metadataTotal = NETWORK_PROBES.filter((probe) => probe.kind === "metadata").length;
  record("metadata_blocking", metadataBlocked.length === metadataTotal ? "PASS" : "FAIL", {
    blocked: metadataBlocked,
  });
  if (metadataBlocked.length !== metadataTotal) {
    throw new Error("one or more metadata probes was reachable");
  }
}

function inspectSandbox(sandbox: Sandbox): void {
  record("sandbox_inspect", "INFO", {
    id: sandbox.id,
    state: sandbox.state,
    snapshot: sandbox.snapshot,
    networkBlockAll: sandbox.networkBlockAll,
    networkAllowList: sandbox.networkAllowList,
    domainAllowList: sandbox.domainAllowList,
    public: sandbox.public,
    toolboxProxyUrlPresent: Boolean(sandbox.toolboxProxyUrl),
    runnerId: sandbox.runnerId,
    sandboxClass: sandbox.sandboxClass,
  });

  if (!sandbox.networkBlockAll) throw new Error("sandbox came up with networkBlockAll false");
  if (sandbox.networkAllowList || sandbox.domainAllowList) {
    throw new Error("sandbox came up with a non-empty egress allow list");
  }
  if (sandbox.public !== false) throw new Error("sandbox is not private");
}

async function main(): Promise<void> {
  const config = readProbeConfig(process.argv.slice(2), process.env);
  const snapshot = await getSnapshot(config.snapshot);
  const labels = { [PROBE_LABEL]: PROBE_RUN };
  let sandbox: Sandbox | null = null;

  record("input", "INFO", {
    snapshot: config.snapshot,
    expectedImageRef: config.expectedImageRef,
    allowedSnapshotImageRef: config.allowedSnapshotImageRef ?? null,
    ttlMinutes: config.ttlMinutes,
    probeRun: PROBE_RUN,
  });
  record("snapshot", "INFO", {
    id: snapshot.id,
    name: snapshot.name,
    imageName: snapshot.imageName,
    state: snapshot.state,
    cpu: snapshot.cpu,
    mem: snapshot.mem,
    disk: snapshot.disk,
  });

  try {
    sandbox = await createSandbox(
      {
        snapshot: config.snapshot,
        imageRef: config.expectedImageRef,
        ...specLimits(snapshot),
        ttlMinutes: config.ttlMinutes,
        labels,
      },
      config.allowedSnapshotImageRef,
    );
    record("sandbox_created", "PASS", { id: sandbox.id });

    sandbox = await waitForState(sandbox.id, ["started", "running"]);
    inspectSandbox(sandbox);
    await verifyTools(sandbox);
    await verifyBackgroundAndLocalhost(sandbox);
    await verifyNoEgressAndMetadata(sandbox);
  } catch (error) {
    if (!sandbox) {
      try {
        record("create_failure_sweep", "INFO", { swept: await sweep(5) });
      } catch (sweepError) {
        record("create_failure_sweep", "FAIL", sweepError instanceof Error ? sweepError.message : String(sweepError));
      }
    }
    throw error;
  } finally {
    if (sandbox) {
      await cleanupLocalServer(sandbox);
      await deleteSandbox(sandbox.id);
      record("sandbox_delete_called", "PASS", { id: sandbox.id });
      await assertSandboxGone(sandbox.id);
      record("sandbox_absent", "PASS", { id: sandbox.id });
      try {
        record("labelled_sweep", "INFO", { swept: await sweep(1, sandbox.id) });
      } catch (error) {
        record("labelled_sweep", "FAIL", error instanceof Error ? error.message : String(error));
      }
    }
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .then(() => {
    console.log("REPORT " + JSON.stringify({ status: "PASS", checks }, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    console.error("REPORT " + JSON.stringify({ status: "FAIL", checks }, null, 2));
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

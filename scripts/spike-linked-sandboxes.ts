/**
 * Linked-sandbox spike. Disposable, and deliberately narrow.
 *
 * Answers the one question the multi-service reproduction mesh rests on: can two Daytona
 * sandboxes talk to each other over a private link network WHILE both have networkBlockAll set,
 * so neither can reach the internet? And is that link network private to the linked group, so a
 * sandbox outside the group cannot reach into it?
 *
 *   npm run spike:linked -- [snapshot-id-or-name]
 *
 * Defaults to the daytona-small snapshot (the stock daytonaio/sandbox image, which has curl and
 * python3). The snapshot only has to boot a shell with those two tools; nothing app-specific.
 *
 * This bypasses lib/sandbox/daytona's createSandbox on purpose: that function hardcodes
 * networkBlockAll and forbids extra fields, which is exactly right for production and exactly
 * wrong for a spike whose whole point is to send linkedSandbox alongside networkBlockAll and see
 * what the live API does. The raw create body here is the discovery: the fields it accepts and
 * the fields it echoes back define the wrapper extension the real change would need.
 *
 * Run against the live API on 2026-09-08, this passed: A reached B by B's sandbox id (resolved
 * to the 172.25.x link address in /etc/hosts) on a shared runner; both A and B still got a 403
 * "Internet is restricted" on 1.1.1.1 and the 169.254.169.254 metadata endpoint; and an unlinked
 * sandbox C could not reach B by id or by either IP.
 *
 * Exiting zero is the claim that the link worked and both nodes were internet-blocked. Every
 * such claim is an assertion, so a run where the link fails, or where a node can still reach the
 * internet, fails loudly rather than printing a reassuring log. Whatever this run creates is torn
 * down in the finally, and swept by label as a backstop.
 */
import { randomUUID } from "node:crypto";

import {
  PURPOSE,
  PURPOSE_LABEL,
  deleteSandbox,
  execute,
  getSandbox,
  getSnapshot,
  listSandboxes,
  type Sandbox,
} from "@/lib/sandbox/daytona";

const API = "https://app.daytona.io/api";
const DEFAULT_SNAPSHOT = "daytona-small";
const PORT = 8080;
const TOKEN = `LINK-OK-${randomUUID()}`;

const SPIKE_LABEL = "bountydesk.spike";
const SPIKE_RUN = `linked-${randomUUID()}`;

/** The two acceptable shapes of a blocked egress probe (mirrors lib/sandbox/capability-probe):
 *  nothing came back at all, or the interception proxy answered 403 "Internet is restricted". */
const DENIAL = "Internet is restricted";
const DENIAL_STATUS = "403";

function apiKey(): string {
  const key = process.env.DAYTONA_API_KEY;
  if (!key) throw new Error("DAYTONA_API_KEY is not set (run with --env-file=.env.local)");
  return key;
}

const evidence: Record<string, unknown> = {};
const step = (name: string, value: unknown) => {
  evidence[name] = value;
  console.log(`  ${name}:`, typeof value === "string" ? value : JSON.stringify(value));
};

/** The whole reason this script exists: a create body we control, so linkedSandbox can ride
 *  alongside networkBlockAll. Returns the full parsed response so the caller can discover which
 *  fields the API echoes for a linked sandbox. */
async function rawCreate(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}/sandbox`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /sandbox -> ${res.status} ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

function nodeBody(extra: Record<string, unknown>, snapshotId: string): Record<string, unknown> {
  return {
    snapshot: snapshotId,
    ttlMinutes: 10,
    networkBlockAll: true,
    public: false,
    autoDeleteInterval: 0,
    labels: { [SPIKE_LABEL]: SPIKE_RUN, [PURPOSE_LABEL]: PURPOSE },
    ...extra,
  };
}

async function waitForRunning(id: string, timeoutMs = 150_000): Promise<Sandbox> {
  const deadline = Date.now() + timeoutMs;
  let last: Sandbox | undefined;
  while (Date.now() < deadline) {
    last = await getSandbox(id);
    if (["started", "running"].includes(last.state)) return last;
    if (["error", "build_failed", "destroyed"].includes(last.state)) {
      throw new Error(`sandbox ${id} reached ${last.state} while starting`);
    }
    await sleep(3000);
  }
  throw new Error(`sandbox ${id} timed out starting; last state ${last?.state ?? "unknown"}`);
}

/** One egress probe, using the same two-part refusal test the real verifyNoEgress uses. */
async function egressProbe(sandbox: Sandbox, url: string): Promise<{ blocked: boolean; detail: unknown }> {
  const script = [
    ": > /tmp/e.body",
    `curl -sS --max-time 8 -o /tmp/e.body -w '%{http_code}' '${url}' > /tmp/e.status 2>/tmp/e.err`,
    'echo "PROBE curl_exit=$? status=$(cat /tmp/e.status)"',
    'echo "BODY $(head -c 120 /tmp/e.body | tr -d \'\\n\')"',
  ].join("; ");
  const out = (await execute(sandbox, script, 20)).result;
  const m = /PROBE curl_exit=(\d+) status=(\d*)/.exec(out);
  const curlExit = m ? Number(m[1]) : null;
  const status = !m || m[2] === "" || m[2] === "000" ? null : m[2];
  const body = /BODY (.*)/.exec(out)?.[1]?.trim() ?? "";
  // Fail closed: only the interception proxy's 403 with its denial body proves egress was blocked,
  // the same rule the production classifier uses (lib/sandbox/provision.ts). A transport failure, a
  // truncated result, or a missing PROBE marker is not proof of a block (it could be a transient
  // error), so it does not pass the gate.
  const blocked = status === DENIAL_STATUS && body.includes(DENIAL);
  return { blocked, detail: { url, curlExit, status, body: body.slice(0, 80) } };
}

/** An HTTP GET from inside a sandbox to a host:port. Reports the status and whether the body
 *  carried our unique token, so a coincidental other listener cannot read as a pass. */
async function httpGet(from: Sandbox, host: string): Promise<{ code: string | null; hasToken: boolean; raw: string }> {
  const script = [
    ": > /tmp/g.body",
    `curl -sS --max-time 6 -o /tmp/g.body -w '%{http_code}' 'http://${host}:${PORT}/' > /tmp/g.status 2>/tmp/g.err`,
    'echo "GET curl_exit=$? status=$(cat /tmp/g.status)"',
    'echo "BODY $(head -c 80 /tmp/g.body | tr -d \'\\n\')"',
  ].join("; ");
  const out = (await execute(from, script, 15)).result;
  const m = /GET curl_exit=(\d+) status=(\d*)/.exec(out);
  const status = !m || m[2] === "" || m[2] === "000" ? null : m[2];
  const body = /BODY (.*)/.exec(out)?.[1] ?? "";
  return { code: status, hasToken: body.includes(TOKEN), raw: out.slice(0, 200) };
}

async function requireTools(sandbox: Sandbox, label: string): Promise<void> {
  const out = (await execute(sandbox, "command -v curl >/dev/null && command -v python3 >/dev/null && echo TOOLS_OK", 15)).result;
  if (!out.includes("TOOLS_OK")) throw new Error(`${label} is missing curl or python3, so the spike proves nothing`);
}

async function startServer(sandbox: Sandbox): Promise<void> {
  const out = (await execute(
    sandbox,
    [
      "cd /tmp",
      `printf '%s\\n' '${TOKEN}' > index.html`,
      `nohup python3 -m http.server ${PORT} --bind 0.0.0.0 >/tmp/srv.log 2>&1 &`,
      "sleep 1.5",
      `ss -ltn 2>/dev/null | grep -q ':${PORT} ' && echo SERVER_LISTENING || echo SERVER_DOWN`,
    ].join("; "),
    20,
  )).result;
  if (!out.includes("SERVER_LISTENING")) throw new Error(`server did not come up on ${PORT}: ${out.slice(0, 200)}`);
}

/** B's link address as a peer resolves it: the link network's DNS maps a sandbox id to its private
 *  link ip. This is THE link address, not just any interface B happens to hold, so a probe to it
 *  proves the private-link route rather than an unrelated bridge answering. */
async function linkAddressOf(from: Sandbox, peerId: string): Promise<string | null> {
  const out = (await execute(from, `getent hosts ${peerId} | awk '{print $1}' | head -1`, 15)).result.trim();
  return /^\d+\.\d+\.\d+\.\d+$/.test(out) ? out : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Delete everything this run labelled, retrying the listing with backoff. A create Daytona accepted
 *  can take a moment to appear, and a lost response leaves a labelled sandbox with no id in `created`,
 *  so one point-in-time listing can miss it. Mirrors the retry in scripts/spike-daytona.ts. */
async function sweep(ignore: string[] = [], attempts = 5): Promise<string[]> {
  const labels = { [SPIKE_LABEL]: SPIKE_RUN, [PURPOSE_LABEL]: PURPOSE };
  for (let attempt = 1; ; attempt++) {
    const stragglers = (await listSandboxes(labels)).filter((s) => !ignore.includes(s.id));
    for (const s of stragglers) await deleteSandbox(s.id);
    if (stragglers.length || attempt === attempts) return stragglers.map((s) => s.id);
    await sleep(3000 * attempt);
  }
}

async function main(): Promise<void> {
  const requested = process.argv[2] ?? DEFAULT_SNAPSHOT;
  const snapshot = await getSnapshot(requested);
  step("snapshot", { id: snapshot.id, name: snapshot.name, imageName: snapshot.imageName, state: snapshot.state });
  if (snapshot.state !== "active") throw new Error(`snapshot ${requested} is ${snapshot.state}, not active`);
  const snapshotId = snapshot.id;

  const created: string[] = [];
  try {
    // 1. Parent A (the "app": it will reach the peer). networkBlockAll on.
    console.log("\n1. CREATE parent A (networkBlockAll)");
    const aRaw = await rawCreate(nodeBody({}, snapshotId));
    const aId = String(aRaw.id);
    created.push(aId);
    step("A_id", aId);
    const sbA = await waitForRunning(aId);
    step("A_inspect", { state: sbA.state, networkBlockAll: sbA.networkBlockAll, runnerId: sbA.runnerId });
    await requireTools(sbA, "parent A");

    // 2. Child B (the "datastore": the peer), linked to A, still networkBlockAll. The raw
    //    response is the discovery of what a linked create actually accepts and returns.
    console.log("\n2. CREATE child B (linkedSandbox=A, ephemeral, networkBlockAll)");
    let bRaw: Record<string, unknown>;
    try {
      bRaw = await rawCreate(nodeBody({ linkedSandbox: aId, ephemeral: true }, snapshotId));
    } catch (error) {
      // The most useful failure this spike can produce: the exact reason the API rejected the
      // linked-create body. That error names the real field, if linkedSandbox is not it.
      step("B_create_failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
    const bId = String(bRaw.id);
    created.push(bId);
    step("B_create_response", bRaw);
    const sbB = await waitForRunning(bId);
    step("B_inspect", { state: sbB.state, networkBlockAll: sbB.networkBlockAll, runnerId: sbB.runnerId });
    step("co_located_same_runner", Boolean(sbA.runnerId) && sbA.runnerId === sbB.runnerId);
    await requireTools(sbB, "child B");

    console.log("\n3. START server on B");
    await startServer(sbB);

    // 4. THE QUESTION: can A reach B over the link network while both are internet-blocked? Require
    //    BOTH routes a linked peer uses: B's sandbox id resolved by the link DNS, and the private
    //    link ip that id maps to. localhost is a negative control: A hitting its own :8080 must not
    //    look like reaching B.
    console.log("\n4. REACH B FROM A (the load-bearing test)");
    const linkIp = await linkAddressOf(sbA, bId);
    step("A_resolved_B_link_ip", linkIp);
    const byId = await httpGet(sbA, bId);
    const byLinkIp = linkIp ? await httpGet(sbA, linkIp) : { code: null, hasToken: false, raw: "no link ip" };
    const control = await httpGet(sbA, "127.0.0.1");
    step("A_reach_B_by_id", { code: byId.code, hasToken: byId.hasToken });
    step("A_reach_B_by_link_ip", { code: byLinkIp.code, hasToken: byLinkIp.hasToken });
    step("A_localhost_control_hasToken", control.hasToken);
    const idReached = byId.code === "200" && byId.hasToken;
    const linkIpReached = byLinkIp.code === "200" && byLinkIp.hasToken;
    step("link_reached_by_id", idReached);
    step("link_reached_by_link_ip", linkIpReached);

    // 5. Both nodes must still be internet-blocked. The mesh is only as strong as its leakiest
    //    node, so this is checked on A and on B.
    console.log("\n5. EGRESS: both nodes internet-blocked");
    const probes = ["http://1.1.1.1", "http://169.254.169.254/latest/meta-data/iam/security-credentials/"];
    const aEgress = await Promise.all(probes.map((u) => egressProbe(sbA, u)));
    const bEgress = await Promise.all(probes.map((u) => egressProbe(sbB, u)));
    step("A_egress", aEgress.map((e) => e.detail));
    step("B_egress", bEgress.map((e) => e.detail));
    const aBlocked = aEgress.every((e) => e.blocked);
    const bBlocked = bEgress.every((e) => e.blocked);
    step("A_internet_blocked", aBlocked);
    step("B_internet_blocked", bBlocked);

    // 6. Isolation: a sandbox OUTSIDE the linked group must not reach B. C carries the same block-all
    //    as A and B but is not linked, so it has no route into the group. Record whether C landed on
    //    the group's runner: block-all or a different runner could also stop C, so this demonstrates
    //    the property that matters (an outsider cannot reach B) rather than isolating the exact
    //    mechanism. C shares the run label and is swept in the finally; it is outside the group
    //    because its create omits linkedSandbox, not because of any label.
    console.log("\n6. ISOLATION: an unlinked sandbox C must NOT reach B");
    const cRaw = await rawCreate(nodeBody({}, snapshotId));
    const cId = String(cRaw.id);
    created.push(cId);
    step("C_id", cId);
    const sbC = await waitForRunning(cId);
    await requireTools(sbC, "outsider C");
    step("C_runner_matches_group", Boolean(sbB.runnerId) && sbC.runnerId === sbB.runnerId);
    const cById = await httpGet(sbC, bId);
    const cByLinkIp = linkIp ? await httpGet(sbC, linkIp) : { code: null, hasToken: false, raw: "no link ip" };
    step("C_reach_B", {
      byId: { code: cById.code, hasToken: cById.hasToken },
      byLinkIp: { code: cByLinkIp.code, hasToken: cByLinkIp.hasToken },
    });
    const outsiderReached =
      (cById.code === "200" && cById.hasToken) || (cByLinkIp.code === "200" && cByLinkIp.hasToken);
    step("outsider_reached_B", outsiderReached);

    // Gates. Exiting zero has to mean all of these held.
    console.log("\n7. VERDICT");
    if (!idReached || !linkIpReached) {
      throw new Error("A did not reach B over BOTH the link DNS and the link ip: the mesh premise is not proven on this provider");
    }
    if (control.hasToken) throw new Error("localhost control returned the token: the reachability test is not measuring the link");
    if (!aBlocked || !bBlocked) throw new Error("a linked node could still reach the internet: block-all does not hold alongside linking");
    if (outsiderReached) throw new Error("an unlinked sandbox reached B: the link network is not private to the group");
    step("verdict", "PASS: A reaches B by id and by link ip with block-all on both nodes, and the outsider cannot reach B");
  } finally {
    console.log("\n8. TEARDOWN");
    // Children first: an ephemeral child may already be gone once its parent is deleted, and a
    // 404 counts as gone inside deleteSandbox.
    for (const id of [...created].reverse()) {
      await deleteSandbox(id).catch((e) => step(`delete_${id}_failed`, e instanceof Error ? e.message : String(e)));
    }
    try {
      step("labelled_stragglers_swept", await sweep());
    } catch (error) {
      step("sweep_failed", error instanceof Error ? error.message : String(error));
    }
  }

  console.log("\nEVIDENCE\n" + JSON.stringify(evidence, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\nSPIKE FAILED:", error instanceof Error ? error.message : error);
    console.error("EVIDENCE SO FAR\n" + JSON.stringify(evidence, null, 2));
    process.exit(1);
  });

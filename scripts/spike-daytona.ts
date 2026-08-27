/**
 * Daytona provisioning spike. Disposable, and deliberately narrow.
 *
 * Answers one question the architecture rests on: can BountyDesk provision an ephemeral
 * sandbox from a named snapshot, see what actually booted, run one fixed harmless command,
 * confirm the reproduction network policy, and destroy it reliably?
 *
 *   npm run spike:daytona -- <snapshot-id-or-name>
 *
 * It creates one reproduction-class sandbox with no network and a short TTL, and it always
 * tries to destroy it, including on failure. Every identifier comes from the argument or from
 * this file; nothing is read from a report, and no platform secret enters the sandbox.
 */
import {
  createSandbox,
  deleteSandbox,
  getSandbox,
  getSnapshot,
  type Sandbox,
} from "@/lib/sandbox/daytona";

const evidence: Record<string, unknown> = {};
const step = (name: string, value: unknown) => {
  evidence[name] = value;
  console.log(`  ${name}:`, typeof value === "string" ? value : JSON.stringify(value));
};

async function waitForState(id: string, wanted: string[], timeoutMs = 120_000): Promise<Sandbox> {
  const deadline = Date.now() + timeoutMs;
  let last: Sandbox | undefined;

  while (Date.now() < deadline) {
    last = await getSandbox(id);
    if (wanted.includes(last.state)) return last;
    if (["error", "build_failed", "destroyed"].includes(last.state)) {
      throw new Error(`sandbox reached ${last.state} while waiting for ${wanted.join(" or ")}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  throw new Error(`timed out in state ${last?.state ?? "unknown"}`);
}

async function main(): Promise<void> {
  const snapshot = process.argv[2];
  if (!snapshot) throw new Error("usage: npm run spike:daytona -- <snapshot-id-or-name>");

  console.log("\n1. REQUESTED");
  step("requested_snapshot", snapshot);
  const info = await getSnapshot(snapshot).catch(() => null);
  step("snapshot_record", info ? { id: info.id, name: info.name, imageName: info.imageName, state: info.state, cpu: info.cpu, mem: info.mem, disk: info.disk } : "not resolvable by id");

  console.log("\n2. PROVISION (reproduction class: no network, short TTL)");
  const created = await createSandbox({
    snapshot,
    purpose: "reproduction",
    // Matched to the snapshot's own declared limits; the client refuses a mismatch.
    cpu: info?.cpu ?? 1,
    memoryGb: info?.mem ?? 1,
    diskGb: info?.disk ?? 3,
    ttlMinutes: 10,
    labels: { "bountydesk.spike": "provisioning" },
  });
  step("sandbox_id", created.id);

  let sandbox: Sandbox | undefined;
  try {
    sandbox = await waitForState(created.id, ["started", "running"]);
    step("state", sandbox.state);

    console.log("\n3. INSPECT (what actually booted, not what we asked for)");
    step("observed_snapshot", sandbox.snapshot);
    step("network_block_all", sandbox.networkBlockAll);
    step("network_allow_list", sandbox.networkAllowList ?? null);
    step("domain_allow_list", sandbox.domainAllowList ?? null);
    step("runner_id", sandbox.runnerId);
    step("sandbox_class", sandbox.sandboxClass);
    step("toolbox_proxy_url_present", Boolean(sandbox.toolboxProxyUrl));

    // The control plane exposes no resolved image digest, so record what it does expose and
    // leave the digest to an in-sandbox check. See the conclusion in the PR.
    step("digest_from_control_plane", "not exposed by the Daytona API");

    console.log("\n4. EXECUTE (one fixed command, chosen here, never supplied by a report)");
    if (!sandbox.toolboxProxyUrl) {
      step("execute", "no toolbox proxy url on the sandbox record");
    } else {
      step("toolbox_proxy_url_host", new URL(sandbox.toolboxProxyUrl).host);

      // The org API key is not the toolbox credential. Recorded rather than worked around:
      // guessing at an undocumented auth scheme is how a spike turns into a rewrite.
      const base = sandbox.toolboxProxyUrl.replace(/\/$/, "");
      const attempt = await fetch(`${base}/toolbox/${created.id}/toolbox/process/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.DAYTONA_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ command: "echo bountydesk-spike-ok" }),
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null);

      step("execute_with_org_key_status", attempt?.status ?? "network error");
      step(
        "execute_conclusion",
        attempt?.status === 401
          ? "GATE NOT PASSED: the toolbox rejects the organisation API key and needs a per-sandbox credential that the control-plane schemas do not expose"
          : `unexpected status ${attempt?.status}; inspect before trusting`,
      );
    }
  } finally {
    console.log("\n5. TEARDOWN");
    await deleteSandbox(created.id);
    step("delete_called", true);

    // Prove it, rather than trusting the call. A second delete must also be safe.
    await deleteSandbox(created.id);
    step("delete_is_idempotent", true);

    const after = await getSandbox(created.id).catch((e) => ({ state: `gone (${String(e).slice(0, 60)})` }));
    step("state_after_delete", (after as { state: string }).state);
  }

  console.log("\nEVIDENCE\n" + JSON.stringify(evidence, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error("\nSPIKE FAILED:", error instanceof Error ? error.message : error);
  console.error("EVIDENCE SO FAR\n" + JSON.stringify(evidence, null, 2));
  process.exit(1);
});

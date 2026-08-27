/**
 * Daytona provisioning spike. Disposable, and deliberately narrow.
 *
 * Answers one question the architecture rests on: can BountyDesk provision an ephemeral
 * sandbox from a named snapshot, see what actually booted, run one fixed harmless command,
 * confirm the reproduction network policy, and destroy it reliably?
 *
 *   npm run spike:daytona -- <snapshot-id-or-name>
 *
 * Exiting zero is the claim that those gates passed, so every gate is an assertion rather than
 * a printed value: a run that observes the wrong snapshot, or network where there should be
 * none, fails loudly instead of producing a reassuring log. Every identifier comes from the
 * argument or from this file; nothing is read from a report, and no platform secret enters the
 * sandbox.
 */
import { randomUUID } from "node:crypto";

import {
  PURPOSE,
  PURPOSE_LABEL,
  assertSandboxGone,
  createSandbox,
  deleteSandbox,
  getSandbox,
  getSnapshot,
  listSandboxes,
  type Sandbox,
} from "@/lib/sandbox/daytona";

const SPIKE_LABEL = "bountydesk.spike";
/**
 * Unique per invocation, so the sweep below can only ever delete this run's own sandboxes.
 * A shared label would let two concurrent runs tear each other's environments down and leave
 * both with evidence describing a sandbox that something else destroyed.
 */
const SPIKE_RUN = `provisioning-${randomUUID()}`;

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

/**
 * Delete everything this run labelled.
 *
 * A create can be accepted by the provider and still fail on our side, to a timeout or an
 * unparseable response, leaving a sandbox whose id we never learned. The run label is the only
 * handle on it. Sweeping older runs too would be reconciliation, which needs age and state
 * guards this script has no business carrying; the real system gets that, built on the same
 * client call.
 */
async function sweep(attempts = 1): Promise<string[]> {
  const labels = { [SPIKE_LABEL]: SPIKE_RUN, [PURPOSE_LABEL]: PURPOSE };

  for (let attempt = 1; ; attempt++) {
    const stragglers = await listSandboxes(labels);
    for (const sandbox of stragglers) await deleteSandbox(sandbox.id);
    if (stragglers.length || attempt === attempts) return stragglers.map((s) => s.id);

    // Nothing yet, which after a lost create means either that no sandbox exists or that the
    // provider has not indexed it. Those look identical from here, so wait and ask again.
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
}

async function main(): Promise<void> {
  const requested = process.argv[2];
  if (!requested) throw new Error("usage: npm run spike:daytona -- <snapshot-id-or-name>");

  console.log("\n1. REQUESTED");
  step("requested_snapshot", requested);
  const info = await getSnapshot(requested);
  step("snapshot_record", {
    id: info.id, name: info.name, imageName: info.imageName,
    state: info.state, cpu: info.cpu, mem: info.mem, disk: info.disk,
  });

  console.log("\n2. PROVISION (reproduction class: no network, short TTL)");
  let created: Sandbox;
  try {
    created = await createSandbox({
      snapshot: requested,
      // Matched to the snapshot's own declared limits; the client refuses a mismatch or a
      // snapshot that declares none, since limits cannot be requested from this provider.
      cpu: info.cpu!,
      memoryGb: info.mem!,
      diskGb: info.disk!,
      ttlMinutes: 10,
      labels: { [SPIKE_LABEL]: SPIKE_RUN },
    });
  } catch (error) {
    // The create may have landed anyway. Nothing else knows its id, so sweep by label, and
    // keep asking: a sandbox the provider accepted can take a moment to appear in a listing,
    // and one immediate empty answer would let it run to its TTL.
    step("create_failed_swept", await sweep(5));
    throw error;
  }
  step("sandbox_id", created.id);

  try {
    const sandbox = await waitForState(created.id, ["started", "running"]);
    step("state", sandbox.state);

    console.log("\n3. INSPECT (what actually booted, not what we asked for)");
    step("observed_snapshot", sandbox.snapshot);
    step("network_block_all", sandbox.networkBlockAll);
    step("network_allow_list", sandbox.networkAllowList ?? null);
    step("domain_allow_list", sandbox.domainAllowList ?? null);
    step("runner_id", sandbox.runnerId);
    step("sandbox_class", sandbox.sandboxClass);
    step("toolbox_proxy_url_present", Boolean(sandbox.toolboxProxyUrl));

    // Gates, not observations. Passing the spike has to mean these were true.
    if (sandbox.snapshot !== info.id && sandbox.snapshot !== info.name) {
      throw new Error(`booted snapshot ${sandbox.snapshot} is neither ${info.id} nor ${info.name}`);
    }
    if (!sandbox.networkBlockAll) {
      throw new Error("reproduction sandbox came up with networkBlockAll false");
    }
    if (sandbox.networkAllowList || sandbox.domainAllowList) {
      throw new Error("reproduction sandbox came up with a non-empty egress allow list");
    }

    // The control plane exposes no resolved image digest, so record what it does expose and
    // leave the digest to an in-sandbox check. See the conclusion in the PR.
    step("digest_from_control_plane", "not exposed by the Daytona API");

    console.log("\n4. EXECUTE (one fixed command, chosen here, never supplied by a report)");
    if (!sandbox.toolboxProxyUrl) {
      step("execute", "no toolbox proxy url on the sandbox record");
    } else {
      step("toolbox_proxy_url_host", new URL(sandbox.toolboxProxyUrl).host);

      // The org API key is not the toolbox credential. Recorded rather than worked around:
      // guessing at an undocumented auth scheme is how a spike turns into a rewrite. This is
      // the one gate that does not throw, because a failure here is the finding.
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

    // Prove it, rather than trusting the call. A second delete must also be safe, and only a
    // 404 counts as gone: a timeout or a 401 means we do not know.
    await deleteSandbox(created.id);
    step("delete_is_idempotent", true);

    await assertSandboxGone(created.id);
    step("confirmed_absent_by_404", true);

    step("labelled_stragglers_swept", await sweep());
  }

  console.log("\nEVIDENCE\n" + JSON.stringify(evidence, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error("\nSPIKE FAILED:", error instanceof Error ? error.message : error);
  console.error("EVIDENCE SO FAR\n" + JSON.stringify(evidence, null, 2));
  process.exit(1);
});

/**
 * Daytona provisioning spike. Disposable, and deliberately narrow.
 *
 * Answers one question the architecture rests on: can BountyDesk provision an ephemeral
 * sandbox from a named snapshot, see what actually booted, run fixed harmless commands, show
 * from inside that the reproduction sandbox really has no egress, and destroy it again?
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
  execute,
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
async function sweep(attempts = 1, ignore?: string): Promise<string[]> {
  const labels = { [SPIKE_LABEL]: SPIKE_RUN, [PURPOSE_LABEL]: PURPOSE };

  for (let attempt = 1; ; attempt++) {
    // The listing lags a delete, so the sandbox we already destroyed and confirmed gone can
    // still appear here. Counting it as a straggler would report a leak that is not one.
    const stragglers = (await listSandboxes(labels)).filter((s) => s.id !== ignore);
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
    // and one immediate empty answer would let it run to its TTL. The create error is what
    // gets rethrown either way; a failed sweep is context, not the cause.
    try {
      step("create_failed_swept", await sweep(5));
    } catch (sweepError) {
      step("create_failed_sweep_also_failed", sweepError instanceof Error ? sweepError.message : String(sweepError));
    }
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

    console.log("\n4. EXECUTE (fixed commands, chosen here, never supplied by a report)");
    const hello = await execute(sandbox, "echo bountydesk-spike-ok");
    step("execute_exit_code", hello.exitCode);
    step("execute_stdout", hello.result.trim());
    if (hello.exitCode !== 0 || !hello.result.includes("bountydesk-spike-ok")) {
      throw new Error(`the fixed command did not run: exit ${hello.exitCode}, output ${hello.result}`);
    }

    console.log("\n5. EGRESS (the policy the control plane claims, checked from inside)");
    // networkBlockAll on the sandbox record says what was configured. Only a probe from inside
    // says what is enforced, and that is the claim the reproduction sandbox rests on.
    //
    // Two ways a naive version of this passes without testing anything. Daytona intercepts
    // egress with a proxy that answers 403 rather than dropping the packet, so a blocked
    // request is a *successful* HTTP transaction and curl exits 0. And a real destination can
    // itself answer 4xx, so status alone cannot tell refusal from a reachable service saying
    // no. A metadata endpoint demanding a header is exactly that case.
    //
    // So there are only two acceptable outcomes per probe: nothing came back at all, or what
    // came back is identifiably the interception proxy. Anything else means the destination
    // answered, whatever it said.
    // Both halves are required. The body alone could in principle be echoed by something the
    // sandbox reached, and the status alone says nothing, since a real destination answers 4xx
    // perfectly well.
    const DENIAL = "Internet is restricted";
    const DENIAL_STATUS = "403";

    // curl absent, a broken shell or a changed toolbox response would otherwise make every
    // probe "fail to connect" and hand back a clean bill of health.
    const haveCurl = await execute(sandbox, "command -v curl >/dev/null && echo CURL_PRESENT", 15);
    if (!haveCurl.result.includes("CURL_PRESENT")) {
      throw new Error("curl is not available in the sandbox, so the egress probes prove nothing");
    }

    const probes: { name: string; url: string; header?: string }[] = [
      // A public HTTPS host, by name.
      { name: "public_https_by_name", url: "https://example.com" },
      // The same shape by literal IP, so a blocked DNS lookup cannot be mistaken for blocked
      // egress. Plain HTTP on purpose: over TLS a certificate that does not match a bare IP
      // fails the request, and that failure would look exactly like the network refusing it.
      { name: "public_ip_no_dns", url: "http://1.1.1.1" },
      // The endpoint that hands out cloud credentials, in both dialects.
      { name: "cloud_metadata_imds", url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" },
      { name: "cloud_metadata_gce", url: "http://169.254.169.254/computeMetadata/v1/", header: "Metadata-Flavor: Google" },
      // Alibaba's metadata address, since the runner's provider is not ours to assume.
      { name: "cloud_metadata_alibaba", url: "http://100.100.100.200/" },
      // The provider's own control plane, in case "no egress" quietly excludes it.
      { name: "daytona_control_plane", url: "https://app.daytona.io/api/health" },
    ];

    const reached: string[] = [];
    for (const probe of probes) {
      const header = probe.header ? `-H '${probe.header}' ` : "";
      const script = [
        ": > /tmp/probe.body",
        `curl -sS --max-time 8 ${header}-o /tmp/probe.body -w '%{http_code}' '${probe.url}' > /tmp/probe.status 2>/tmp/probe.err`,
        "echo \"PROBE curl_exit=$? status=$(cat /tmp/probe.status)\"",
        "echo \"BODY $(head -c 120 /tmp/probe.body | tr -d '\\n')\"",
        "echo \"ERR $(head -c 120 /tmp/probe.err | tr -d '\\n')\"",
      ].join("; ");

      const result = await execute(sandbox, script, 20);
      const output = result.result;
      const parsed = /PROBE curl_exit=(\d+) status=(\d*)/.exec(output);

      // The probe not running is not the same as the probe passing.
      if (result.exitCode !== 0 || !parsed) {
        throw new Error(
          `egress probe ${probe.name} did not run (exit ${result.exitCode}): ${output.slice(0, 200)}`,
        );
      }

      const curlExit = Number(parsed[1]);
      const status = parsed[2] === "" || parsed[2] === "000" ? null : parsed[2];
      const body = /BODY (.*)/.exec(output)?.[1]?.trim() ?? "";
      const err = /ERR (.*)/.exec(output)?.[1]?.trim() ?? "";
      step(`egress_${probe.name}`, { curlExit, status, body: body.slice(0, 120), err: err.slice(0, 120) });

      if (curlExit !== 0 && status === null) continue;
      if (status === DENIAL_STATUS && body.includes(DENIAL)) continue;

      // Everything else is the far end answering, including a 4xx it chose to send.
      reached.push(`${probe.name} (curl ${curlExit}, status ${status ?? "none"})`);
    }

    if (reached.length) {
      throw new Error(`reproduction sandbox reached ${reached.join(", ")} despite networkBlockAll`);
    }
    step("egress_conclusion", "every probe was refused by transport failure or the interception proxy");

    // How it is enforced matters as much as that it is. Recorded because the answer turned out
    // to be an interception proxy rather than an absent route.
    const route = await execute(sandbox, "ip route show; cat /etc/resolv.conf", 15);
    step("egress_mechanism", route.result.trim().slice(0, 400));

  } finally {
    console.log("\n6. TEARDOWN");
    await deleteSandbox(created.id);
    step("delete_called", true);

    // Prove it, rather than trusting the call. A second delete must also be safe, and only a
    // 404 counts as gone: a timeout or a 401 means we do not know.
    await deleteSandbox(created.id);
    step("delete_is_idempotent", true);

    await assertSandboxGone(created.id);
    step("confirmed_absent_by_404", true);

    // A cleanup failure must not become the reported cause: whatever brought us here is more
    // interesting than the sweep that then also failed.
    try {
      step("labelled_stragglers_swept", await sweep(1, created.id));
    } catch (error) {
      step("sweep_failed", error instanceof Error ? error.message : String(error));
    }
  }

  console.log("\nEVIDENCE\n" + JSON.stringify(evidence, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error("\nSPIKE FAILED:", error instanceof Error ? error.message : error);
  console.error("EVIDENCE SO FAR\n" + JSON.stringify(evidence, null, 2));
  process.exit(1);
});

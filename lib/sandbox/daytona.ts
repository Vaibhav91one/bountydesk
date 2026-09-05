import { requireSecret } from "@/lib/env";

/**
 * The smallest boundary BountyDesk needs against Daytona.
 *
 * Deliberately hand-rolled over the REST API rather than the official SDK, which pulls in the
 * AWS S3 client, socket.io, tar and busboy to do things we never do. What we need is five
 * calls, and five calls should not cost twenty dependencies.
 *
 * This module provisions two kinds of sandbox. The reproduction sandbox (createSandbox) has no
 * network at all: networkBlockAll is a constant there, not an argument, so no caller can ask for
 * network by supplying a field. The build sandbox (createBuildSandbox) is the one place that
 * grants egress, and only to a caller-supplied allow-list that must come from a server-held
 * source (lib/build-onboarding), never from report text, a cloned repo's own scripts, or model
 * output. An empty allow-list is refused rather than treated as "network open": an allow-list
 * with nowhere trustworthy to get its value from is a hole disguised as a control, so the build
 * capability fails closed when its list is missing. The two paths are separate functions on
 * purpose: nothing that grants network can be reached from the reproduction path.
 */
const API = "https://app.daytona.io/api";

/** Long enough for a slow provision, short enough that a hung call cannot wedge a worker. */
const TIMEOUT_MS = 30_000;

/** Stamped on everything this module creates, so an abandoned sandbox can be found again. */
export const PURPOSE_LABEL = "bountydesk.purpose";
export const PURPOSE = "reproduction";
/** Build sandboxes carry their own purpose so a teardown sweep can tell them from a
 *  reproduction sandbox and clean up an abandoned build without touching a live run. */
export const BUILD_PURPOSE = "build";

/**
 * Our ceiling, not the provider's. Daytona is happy to keep a sandbox alive far longer than any
 * reproduction needs, and a run that is still up tomorrow is a leak with a receipt.
 */
export const MAX_TTL_MINUTES = 60;

/**
 * Our ceiling on a single command. Zero would hand the sandbox no deadline of its own while the
 * HTTP request still aborts, which leaves the command running with nothing left watching it.
 */
export const MAX_EXEC_SECONDS = 300;

export type SandboxSpec = {
  /**
   * Which snapshot to boot. The caller owns this value and it is never derived from report
   * text, an attachment or model output. Today the only caller is the spike script, where it
   * is an operator argument; when the analysis driver lands it comes from the TargetProfile.
   */
  snapshot: string;
  /**
   * The digest-pinned image this run expects the snapshot to be built from, as
   * `registry/name@sha256:<64 hex>`. A mutable tag proves nothing: the whole point of pinning
   * to a digest is that the reference cannot come to mean a different image later. Compared
   * exactly against the snapshot's own `imageName`, never derived from it.
   */
  imageRef: string;
  /**
   * The limits this run expects. Daytona refuses resource fields on a create-from-snapshot
   * ("Cannot specify Sandbox resources when using a snapshot"), because the snapshot carries
   * them. So these are not requested, they are checked against what the snapshot declares,
   * and a mismatch fails closed rather than running with limits nobody chose.
   */
  cpu: number;
  memoryGb: number;
  diskGb: number;
  /** Wall-clock ceiling, whole minutes, at most MAX_TTL_MINUTES. Refused without one. */
  ttlMinutes: number;
  labels?: Record<string, string>;
};

export type Sandbox = {
  id: string;
  state: string;
  snapshot: string | null;
  networkBlockAll: boolean;
  networkAllowList: string | null;
  domainAllowList: string | null;
  toolboxProxyUrl: string | null;
  runnerId: string | null;
  sandboxClass: string | null;
  public: boolean;
};

export class DaytonaError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "DaytonaError";
  }
}

/** Raised before any network call when a spec would create something unsafe. */
export class UnsafeSandboxSpec extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeSandboxSpec";
  }
}

/**
 * Refuse a spec that cannot be provisioned safely, before it reaches the provider.
 *
 * Fail-closed matters more here than anywhere else in the codebase: a reproduction sandbox
 * that quietly comes up with network is indistinguishable from one that came up correctly,
 * right up until a proof-of-concept exfiltrates something. So the unsafe case is an
 * exception, never a default that gets logged.
 */
export function assertSafeSpec(spec: SandboxSpec): void {
  if (!spec.snapshot || !/^[A-Za-z0-9._:@/-]{1,200}$/.test(spec.snapshot)) {
    throw new UnsafeSandboxSpec("snapshot must be a server-held identifier");
  }

  // Anchors the request to one immutable manifest. A mutable tag (":v17.3.0", ":latest") would
  // pass this shape check while meaning a different image tomorrow than it means today.
  if (!spec.imageRef || !/^[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$/.test(spec.imageRef)) {
    throw new UnsafeSandboxSpec("imageRef must be a digest-pinned reference (registry/name@sha256:<64 hex>)");
  }

  for (const n of [spec.cpu, spec.memoryGb, spec.diskGb, spec.ttlMinutes]) {
    if (!Number.isFinite(n) || n <= 0) {
      throw new UnsafeSandboxSpec("cpu, memory, disk and ttl must all be positive");
    }
  }

  // A fractional TTL is a typo the provider would round somewhere of its own choosing, and an
  // enormous one is how a sandbox is still running next week.
  if (!Number.isInteger(spec.ttlMinutes) || spec.ttlMinutes > MAX_TTL_MINUTES) {
    throw new UnsafeSandboxSpec(`ttl must be a whole number of minutes, at most ${MAX_TTL_MINUTES}`);
  }

  // Daytona documents 1 GiB as the floor; asking for less is silently raised, which would make
  // the recorded limit a lie.
  if (spec.memoryGb < 1) throw new UnsafeSandboxSpec("memory below the 1 GiB provider minimum");
}

/**
 * Refuse a snapshot whose baked-in limits are not the ones this run expects.
 *
 * A missing value counts as a mismatch, not as agreement. Since limits cannot be requested,
 * the snapshot record is the only evidence there is, and a snapshot that declines to say what
 * it allocates has not shown us anything. Recording a limit we never applied would make the
 * evidence packet wrong, and "we capped it at 2 GiB" is exactly the sort of claim that has to
 * be true.
 */
export function assertSnapshotLimits(spec: SandboxSpec, snapshot: SnapshotInfo): void {
  const compare = (label: string, declared: number | null, expected: number) =>
    declared == null
      ? `${label} not declared by the snapshot`
      : declared !== expected
        ? `${label} ${declared} != ${expected}`
        : null;

  const mismatch = [
    compare("cpu", snapshot.cpu, spec.cpu),
    compare("memory", snapshot.mem, spec.memoryGb),
    compare("disk", snapshot.disk, spec.diskGb),
  ].filter(Boolean);

  if (mismatch.length) {
    throw new UnsafeSandboxSpec(
      `snapshot ${snapshot.name} declares limits this run did not choose: ${mismatch.join(", ")}`,
    );
  }
}

/**
 * Refuse a snapshot that was not built from the image this run expects.
 *
 * This is the one check in this file that ties a sandbox back to a specific build. Everything
 * else about a snapshot (its state, its limits) can be true of any number of images; the
 * `imageName` the provider recorded when the snapshot was created is the only field that says
 * which one. A missing `imageName` counts as a mismatch, the same way a missing limit does:
 * a snapshot that declines to say what it was built from has not shown us anything.
 *
 * `allowedImageNameOverride` is a narrow, explicit escape hatch, not a general bypass. It exists
 * because Daytona's `POST /api/snapshots` currently refuses a digest-pinned `imageName` outright
 * (confirmed live against both GHCR and a plain Docker Hub image, see PR #31's description), so
 * no snapshot registered today can ever satisfy the digest-exact check above. When the caller
 * passes one, a snapshot is also accepted if its `imageName` matches that exact, explicitly
 * supplied value -- never a pattern, never derived from `spec` -- on top of the digest match,
 * never instead of validating that the two are different things. A caller that uses this without
 * immediately re-verifying build identity from inside the booted sandbox (see build-marker.ts)
 * has removed the one check this file makes for identity, so it must never be the default path.
 */
export function assertSnapshotImage(
  spec: SandboxSpec,
  snapshot: SnapshotInfo,
  allowedImageNameOverride?: string,
): void {
  if (snapshot.imageName === spec.imageRef) return;
  if (allowedImageNameOverride && snapshot.imageName === allowedImageNameOverride) return;

  throw new UnsafeSandboxSpec(
    `snapshot ${snapshot.name} image ${snapshot.imageName ?? "(not declared)"} != expected ${spec.imageRef}` +
      (allowedImageNameOverride ? ` (and != allowed override ${allowedImageNameOverride})` : ""),
  );
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${requireSecret("DAYTONA_API_KEY")}`,
      "content-type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new DaytonaError(`${init.method ?? "GET"} ${path} -> ${response.status} ${body.slice(0, 300)}`, response.status);
  }

  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

/**
 * Provision one ephemeral reproduction sandbox.
 *
 * `networkBlockAll` is a constant here, not an argument, so no caller can ask for a sandbox
 * with network by supplying one more field. `env` and `secrets` are never sent: the hostile
 * runtime holds no GitHub token, database URL, webhook secret, model key or Daytona key, and
 * the way to guarantee that is to have no code path that puts one there.
 *
 * The create names the resolved snapshot id rather than whatever string the caller passed.
 * `spec.snapshot` may be a mutable display name, and a name that gets repointed between the
 * lookup and the create would hand back a sandbox built from something other than the
 * snapshot whose state and limits were just checked.
 *
 * `allowedImageNameOverride`, when given, is forwarded to assertSnapshotImage as the one
 * explicitly named exception to its digest-exact check -- see that function's doc comment for
 * why this exists and how narrow it is. Leave it unset and this behaves exactly as before.
 */
export async function createSandbox(spec: SandboxSpec, allowedImageNameOverride?: string): Promise<Sandbox> {
  assertSafeSpec(spec);

  // Verify the limits rather than request them: the provider rejects resource fields
  // alongside a snapshot, so the snapshot is where they actually come from.
  const snapshot = await getSnapshot(spec.snapshot);
  if (snapshot.state !== "active") {
    throw new UnsafeSandboxSpec(`snapshot ${spec.snapshot} is ${snapshot.state}, not active`);
  }
  if (!snapshot.id) {
    throw new UnsafeSandboxSpec(`snapshot ${spec.snapshot} resolved without an immutable id`);
  }
  assertSnapshotLimits(spec, snapshot);
  assertSnapshotImage(spec, snapshot, allowedImageNameOverride);

  const body = {
    snapshot: snapshot.id,
    ttlMinutes: spec.ttlMinutes,
    networkBlockAll: true,
    public: false,
    autoDeleteInterval: 0,
    labels: { ...spec.labels, [PURPOSE_LABEL]: PURPOSE },
  };

  const created = await call<Sandbox>("/sandbox", { method: "POST", body: JSON.stringify(body) });

  // Without an id there is nothing to inspect, nothing to tear down, and nothing to reconcile
  // later. A response that cannot answer "which sandbox?" is not usable at any price.
  if (typeof created.id !== "string" || !created.id) {
    throw new DaytonaError(`provisioning returned no sandbox id: ${JSON.stringify(created).slice(0, 200)}`);
  }

  // Asked for and got are different things, and a publicly reachable sandbox running a target
  // built from someone else's report is the one outcome there is no recovering from. So this
  // wants an explicit false, not the absence of a true: a field the provider stopped sending
  // would otherwise read as private.
  if (created.public !== false) {
    await destroyRejected(created.id, created.public === true ? "came up public" : "did not report whether it is public");
  }

  return created;
}

export async function getSandbox(id: string): Promise<Sandbox> {
  return call<Sandbox>(`/sandbox/${encodeURIComponent(id)}?verbose=true`);
}

/**
 * Everything carrying these labels. The basis of both teardown sweeps and reconciliation.
 *
 * The list is paginated and the caller wants all of it: a sweep that stops at the first page
 * silently leaves the rest running.
 */
export async function listSandboxes(labels: Record<string, string>): Promise<Sandbox[]> {
  const found: Sandbox[] = [];
  let cursor: string | null = null;

  do {
    const query = new URLSearchParams({ labels: JSON.stringify(labels) });
    if (cursor) query.set("cursor", cursor);

    const page: { items: Sandbox[]; nextCursor: string | null } = await call(`/sandbox?${query}`);
    found.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);

  return found;
}

/**
 * Destroy a sandbox, and keep asking until it takes.
 *
 * Two provider behaviours make the naive version leak. A freshly started sandbox answers
 * DELETE with 409 "Sandbox state change in progress", so a teardown in a `finally` block
 * fails exactly when it matters most. And a sandbox that is already gone answers 404, which
 * is the desired state rather than an error. Both are handled here so a caller can treat
 * teardown as something that simply happens.
 *
 * This is best-effort by design. The provider TTL is the real guarantee, and a reconciler
 * still has to sweep: a process that dies here never gets to retry.
 */
export async function deleteSandbox(id: string, attempts = 6, baseDelayMs = 2000): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await call<void>(`/sandbox/${encodeURIComponent(id)}`, { method: "DELETE" });
      return;
    } catch (error) {
      if (error instanceof DaytonaError && error.status === 404) return;

      const inProgress = error instanceof DaytonaError && error.status === 409;
      if (!inProgress || attempt === attempts) throw error;

      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
}

/**
 * Confirm a sandbox is really gone.
 *
 * Only a 404 proves absence. A timeout, a 401 or a provider outage all mean "we do not know",
 * and treating those as success is how a leak gets recorded as a clean teardown.
 */
export async function assertSandboxGone(id: string): Promise<void> {
  try {
    const still = await getSandbox(id);
    throw new DaytonaError(`sandbox ${id} still exists in state ${still.state}`);
  } catch (error) {
    if (error instanceof DaytonaError && error.status === 404) return;
    throw error;
  }
}

/**
 * Tear down a sandbox we have decided not to use, and refuse to say it is gone unless it is.
 *
 * A successful DELETE is a request the provider accepted, which is not the same as a sandbox
 * that no longer exists. Reporting "destroyed" over a failed teardown would hide a reachable
 * hostile sandbox behind a reassuring message, so both the delete and the confirmation have to
 * hold, and the id travels in every message because whoever handles this needs something to
 * reconcile with.
 */
async function destroyRejected(id: string, reason: string): Promise<never> {
  try {
    await deleteSandbox(id);
    await assertSandboxGone(id);
  } catch (error) {
    throw new UnsafeSandboxSpec(
      `sandbox ${id} ${reason} AND could not be confirmed destroyed (${
        error instanceof Error ? error.message : String(error)
      }); it may be reachable until its TTL expires`,
    );
  }

  throw new UnsafeSandboxSpec(`sandbox ${id} ${reason}; destroyed and confirmed gone`);
}

export type ExecResult = { exitCode: number; result: string };

/**
 * Run one command inside a sandbox, through the toolbox proxy.
 *
 * The command is always chosen by the server. Nothing here parses it, and nothing upstream may
 * build it from report text, an attachment or model output: this is the call that turns a
 * string into execution, so it is the one place where that rule has to hold absolutely.
 *
 * The proxy takes the same organisation key as the control plane, with the sandbox id as a path
 * segment: `<toolboxProxyUrl>/<id>/process/execute`.
 */
export async function execute(
  sandbox: Sandbox,
  command: string,
  timeoutSeconds = 30,
): Promise<ExecResult> {
  if (!sandbox.toolboxProxyUrl) {
    throw new DaytonaError(`sandbox ${sandbox.id} has no toolbox proxy url`);
  }

  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > MAX_EXEC_SECONDS) {
    throw new UnsafeSandboxSpec(
      `a command timeout must be a whole number of seconds between 1 and ${MAX_EXEC_SECONDS}`,
    );
  }

  const base = sandbox.toolboxProxyUrl.replace(/\/$/, "");
  const response = await fetch(`${base}/${encodeURIComponent(sandbox.id)}/process/execute`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${requireSecret("DAYTONA_API_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ command, timeout: timeoutSeconds }),
    signal: AbortSignal.timeout((timeoutSeconds + 10) * 1000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new DaytonaError(`execute -> ${response.status} ${body.slice(0, 300)}`, response.status);
  }

  const data = (await response.json()) as { exitCode?: unknown; code?: unknown; result?: unknown };
  const exitCode = data.exitCode ?? data.code;
  const result = data.result;

  // A cast is a promise to the compiler, not a check. If the toolbox ever answers with a shape
  // other than this, the caller should learn about it here rather than three frames later when
  // something calls .trim on an object.
  //
  // Neither field gets a default. A missing exit status must not become 0, and a missing result
  // must not become "": a probe that reads the output of a command would then see a truncated
  // response as a command that ran and printed nothing.
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || typeof result !== "string") {
    throw new DaytonaError(
      `toolbox returned an unusable result for a command in ${sandbox.id}: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }

  return { exitCode, result };
}

export type SnapshotInfo = {
  id: string;
  name: string;
  imageName: string | null;
  state: string;
  cpu: number | null;
  mem: number | null;
  disk: number | null;
};

/** Look up what a snapshot claims to be, so the request can be recorded beside the result. */
export async function getSnapshot(id: string): Promise<SnapshotInfo> {
  return call<SnapshotInfo>(`/snapshots/${encodeURIComponent(id)}`);
}

/**
 * The build sandbox: the one path in this file that grants a sandbox network access.
 *
 * Boots from a server-held base snapshot (a Docker-in-Docker image, so the onboarding pipeline
 * can run `docker build` inside it) with egress limited to `egressAllowList`. That list is the
 * whole safety story, so it must come from a server-held source and is refused when empty: an
 * empty list must never silently become "network open". The base snapshot is our own, so its
 * image is not digest-checked the way a reproduction snapshot's is; what a build sandbox runs is
 * untrusted, but it holds no app secret beyond a push credential and is torn down after the
 * snapshot is registered.
 */
export type BuildSandboxSpec = {
  /** A server-held DinD base snapshot to boot the builder from. */
  snapshot: string;
  cpu: number;
  memoryGb: number;
  diskGb: number;
  ttlMinutes: number;
  labels?: Record<string, string>;
};

export async function createBuildSandbox(
  spec: BuildSandboxSpec,
  egressAllowList: string[],
): Promise<Sandbox> {
  const hosts = egressAllowList.map((h) => h.trim()).filter(Boolean);
  if (hosts.length === 0) {
    // Fail closed. A build sandbox with no allow-list is either a misconfiguration or an attempt
    // to widen it to everything; neither may be treated as "network open".
    throw new UnsafeSandboxSpec("a build sandbox requires a non-empty, server-held egress allow-list");
  }
  if (typeof spec.snapshot !== "string" || !spec.snapshot) {
    throw new UnsafeSandboxSpec("build sandbox snapshot must be a server-held identifier");
  }
  if (spec.cpu <= 0 || spec.memoryGb <= 0 || spec.diskGb <= 0 || spec.ttlMinutes <= 0) {
    throw new UnsafeSandboxSpec("cpu, memory, disk and ttl must all be positive");
  }
  if (!Number.isInteger(spec.ttlMinutes) || spec.ttlMinutes > MAX_TTL_MINUTES) {
    throw new UnsafeSandboxSpec(`ttl must be a whole number of minutes, at most ${MAX_TTL_MINUTES}`);
  }

  const snapshot = await getSnapshot(spec.snapshot);
  if (snapshot.state !== "active") {
    throw new UnsafeSandboxSpec(`build snapshot ${spec.snapshot} is ${snapshot.state}, not active`);
  }
  if (!snapshot.id) {
    throw new UnsafeSandboxSpec(`build snapshot ${spec.snapshot} resolved without an immutable id`);
  }

  const body = {
    snapshot: snapshot.id,
    ttlMinutes: spec.ttlMinutes,
    networkBlockAll: false,
    // Daytona's domainAllowList restricts egress to these hostnames; networkAllowList is for
    // CIDR ranges and would reject a hostname. The build needs names (a git host, a registry),
    // so this is the domain field.
    domainAllowList: hosts.join(","),
    public: false,
    autoDeleteInterval: 0,
    labels: { ...spec.labels, [PURPOSE_LABEL]: BUILD_PURPOSE },
  };

  const created = await call<Sandbox>("/sandbox", { method: "POST", body: JSON.stringify(body) });
  if (typeof created.id !== "string" || !created.id) {
    throw new DaytonaError(`build provisioning returned no sandbox id: ${JSON.stringify(created).slice(0, 200)}`);
  }
  if (created.public !== false) {
    await destroyRejected(created.id, created.public === true ? "came up public" : "did not report whether it is public");
  }
  return created;
}

/**
 * Register a Daytona snapshot from an already-pushed image, so a later reproduction can boot it.
 *
 * `image` must be a tag reference, not digest-pinned: Daytona's `POST /api/snapshots` rejects an
 * imageName containing `@sha256:` as an invalid reference (see lib/targets/configure.ts). The tag
 * is not the pin that matters at reproduction time; buildMarkerCheck re-proves image identity from
 * inside the booted sandbox, which is what the reproduction path actually trusts.
 */
export type CreateSnapshotSpec = {
  name: string;
  image: string;
  cpu: number;
  memoryGb: number;
  diskGb: number;
};

export async function createSnapshot(spec: CreateSnapshotSpec): Promise<SnapshotInfo> {
  if (spec.image.includes("@sha256:")) {
    throw new UnsafeSandboxSpec(
      "Daytona rejects a digest-pinned imageName in POST /snapshots; register the tag and let buildMarkerCheck verify identity",
    );
  }
  return call<SnapshotInfo>("/snapshots", {
    method: "POST",
    body: JSON.stringify({
      name: spec.name,
      imageName: spec.image,
      cpu: spec.cpu,
      memory: spec.memoryGb,
      disk: spec.diskGb,
    }),
  });
}

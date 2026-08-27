import { requireSecret } from "@/lib/env";

/**
 * The smallest boundary BountyDesk needs against Daytona.
 *
 * Deliberately hand-rolled over the REST API rather than the official SDK, which pulls in the
 * AWS S3 client, socket.io, tar and busboy to do things we never do. What we need is four
 * calls, and four calls should not cost twenty dependencies.
 *
 * Every field here is server-controlled. Nothing in this module reads issue text, email
 * bodies, attachments or model output, and nothing accepts a snapshot, image, host or command
 * from a caller that got one of those. The profile decides; this module executes.
 */
const API = "https://app.daytona.io/api";

/** Long enough for a slow provision, short enough that a hung call cannot wedge a worker. */
const TIMEOUT_MS = 30_000;

export type SandboxPurpose = "build" | "reproduction";

export type SandboxSpec = {
  /** Snapshot id or name, taken from a server-held TargetProfile. Never from a payload. */
  snapshot: string;
  purpose: SandboxPurpose;
  /**
   * The limits this run expects. Daytona refuses resource fields on a create-from-snapshot
   * ("Cannot specify Sandbox resources when using a snapshot"), because the snapshot carries
   * them. So these are not requested, they are checked against what the snapshot declares,
   * and a mismatch fails closed rather than running with limits nobody chose.
   */
  cpu: number;
  memoryGb: number;
  diskGb: number;
  /** Wall-clock ceiling. Provisioning refuses a spec without one. */
  ttlMinutes: number;
  /**
   * Only a build may name hosts, and only these. A reproduction sandbox gets no network at
   * all, which is enforced below rather than requested politely.
   */
  domainAllowList?: string[];
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

  if (spec.purpose === "reproduction" && spec.domainAllowList?.length) {
    throw new UnsafeSandboxSpec(
      "a reproduction sandbox gets no network, so it cannot carry a domain allow list",
    );
  }

  if (spec.purpose === "build" && !spec.domainAllowList?.length) {
    throw new UnsafeSandboxSpec(
      "a build sandbox must name the hosts it may reach; an empty list would mean unrestricted",
    );
  }

  for (const n of [spec.cpu, spec.memoryGb, spec.diskGb, spec.ttlMinutes]) {
    if (!Number.isFinite(n) || n <= 0) {
      throw new UnsafeSandboxSpec("cpu, memory, disk and ttl must all be positive");
    }
  }

  // Daytona documents 1 GiB as the floor; asking for less is silently raised, which would make
  // the recorded limit a lie.
  if (spec.memoryGb < 1) throw new UnsafeSandboxSpec("memory below the 1 GiB provider minimum");
}

/**
 * Refuse a snapshot whose baked-in limits are not the ones this run expects.
 *
 * Recording a limit we never applied would make the evidence packet wrong, and "we capped it
 * at 2 GiB" is exactly the sort of claim that has to be true.
 */
export function assertSnapshotLimits(spec: SandboxSpec, snapshot: SnapshotInfo): void {
  const mismatch = [
    snapshot.cpu != null && snapshot.cpu !== spec.cpu ? `cpu ${snapshot.cpu} != ${spec.cpu}` : null,
    snapshot.mem != null && snapshot.mem !== spec.memoryGb ? `memory ${snapshot.mem} != ${spec.memoryGb}` : null,
    snapshot.disk != null && snapshot.disk !== spec.diskGb ? `disk ${snapshot.disk} != ${spec.diskGb}` : null,
  ].filter(Boolean);

  if (mismatch.length) {
    throw new UnsafeSandboxSpec(
      `snapshot ${snapshot.name} declares limits this run did not choose: ${mismatch.join(", ")}`,
    );
  }
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
 * Provision one ephemeral sandbox.
 *
 * `networkBlockAll` is derived from the purpose rather than passed in, so a caller cannot ask
 * for a reproduction sandbox with network by supplying one more argument. `env` and `secrets`
 * are never sent: the hostile runtime holds no GitHub token, database URL, webhook secret,
 * model key or Daytona key, and the way to guarantee that is to have no code path that puts
 * one there.
 */
export async function createSandbox(spec: SandboxSpec): Promise<Sandbox> {
  assertSafeSpec(spec);

  // Verify the limits rather than request them: the provider rejects resource fields
  // alongside a snapshot, so the snapshot is where they actually come from.
  const snapshot = await getSnapshot(spec.snapshot);
  if (snapshot.state !== "active") {
    throw new UnsafeSandboxSpec(`snapshot ${spec.snapshot} is ${snapshot.state}, not active`);
  }
  assertSnapshotLimits(spec, snapshot);

  const body: Record<string, unknown> = {
    snapshot: spec.snapshot,
    ttlMinutes: spec.ttlMinutes,
    networkBlockAll: spec.purpose === "reproduction",
    autoDeleteInterval: 0,
    labels: { ...spec.labels, "bountydesk.purpose": spec.purpose },
  };

  if (spec.purpose === "build") body.domainAllowList = spec.domainAllowList!.join(",");

  return call<Sandbox>("/sandbox", { method: "POST", body: JSON.stringify(body) });
}

export async function getSandbox(id: string): Promise<Sandbox> {
  return call<Sandbox>(`/sandbox/${encodeURIComponent(id)}?verbose=true`);
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
export async function deleteSandbox(id: string, attempts = 6): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await call<void>(`/sandbox/${encodeURIComponent(id)}`, { method: "DELETE" });
      return;
    } catch (error) {
      if (error instanceof DaytonaError && error.status === 404) return;

      const inProgress = error instanceof DaytonaError && error.status === 409;
      if (!inProgress || attempt === attempts) throw error;

      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
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

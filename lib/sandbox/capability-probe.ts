import type { ExecResult } from "./daytona";

export const REQUIRED_TOOLS = [
  "sh",
  "bash",
  "curl",
  "git",
  "apt-get",
  "tar",
  "unzip",
  "node",
  "npm",
  "python3",
  "nohup",
  "ps",
  "ss",
] as const;

export const EGRESS_DENIAL_STATUS = "403";
export const EGRESS_DENIAL_BODY = "Internet is restricted";

export type ProbeConfig = {
  snapshot: string;
  expectedImageRef: string;
  allowedSnapshotImageRef?: string;
  ttlMinutes: number;
};

export type NetworkProbe = {
  name: string;
  url: string;
  kind: "public" | "metadata" | "control-plane";
  header?: string;
};

export const NETWORK_PROBES: NetworkProbe[] = [
  { name: "public_https_by_name", kind: "public", url: "https://example.com" },
  { name: "public_ip_no_dns", kind: "public", url: "http://1.1.1.1" },
  {
    name: "aws_imds",
    kind: "metadata",
    url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  },
  {
    name: "gce_metadata",
    kind: "metadata",
    url: "http://169.254.169.254/computeMetadata/v1/",
    header: "Metadata-Flavor: Google",
  },
  { name: "alibaba_metadata", kind: "metadata", url: "http://100.100.100.200/" },
  { name: "daytona_control_plane", kind: "control-plane", url: "https://app.daytona.io/api/health" },
];

const SNAPSHOT_RE = /^[A-Za-z0-9._:@/-]{1,200}$/;
const IMAGE_REF_RE = /^[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const IMAGE_NAME_RE = /^[A-Za-z0-9._/-]+$/;

export function readProbeConfig(argv: string[], env: Record<string, string | undefined>): ProbeConfig {
  const options = parseArgs(argv);

  requireRealValue("DAYTONA_API_KEY", env.DAYTONA_API_KEY, { secret: true });

  const snapshot = requireRealValue(
    "snapshot",
    option(options, "snapshot") ?? env.DAYTONA_PROBE_SNAPSHOT,
  );
  if (!SNAPSHOT_RE.test(snapshot)) {
    throw new Error("snapshot must be a real Daytona snapshot id or name");
  }

  const expectedImageRef = resolveExpectedImageRef(options, env);
  const allowedSnapshotImageRef =
    option(options, "allowed-snapshot-image-ref") ?? env.DAYTONA_PROBE_ALLOWED_SNAPSHOT_IMAGE_REF;
  if (allowedSnapshotImageRef) requireRealValue("allowed-snapshot-image-ref", allowedSnapshotImageRef);
  if (allowedSnapshotImageRef && /\s/.test(allowedSnapshotImageRef)) {
    throw new Error("allowed-snapshot-image-ref must not contain whitespace");
  }

  const ttlRaw = option(options, "ttl-minutes") ?? env.DAYTONA_PROBE_TTL_MINUTES ?? "10";
  const ttlMinutes = Number(ttlRaw);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > 60) {
    throw new Error("ttl-minutes must be a whole number between 1 and 60");
  }

  return {
    snapshot,
    expectedImageRef,
    ...(allowedSnapshotImageRef ? { allowedSnapshotImageRef } : {}),
    ttlMinutes,
  };
}

function resolveExpectedImageRef(
  options: Map<string, string>,
  env: Record<string, string | undefined>,
): string {
  const explicitRef = option(options, "expected-image-ref") ?? env.DAYTONA_PROBE_EXPECTED_IMAGE_REF;
  if (explicitRef) {
    const value = requireRealValue("expected-image-ref", explicitRef);
    if (!IMAGE_REF_RE.test(value)) {
      throw new Error("expected-image-ref must be registry/name@sha256:<64 hex>");
    }
    return value;
  }

  const digest = option(options, "expected-image-digest") ?? env.DAYTONA_PROBE_EXPECTED_IMAGE_DIGEST;
  const imageName = option(options, "image-name") ?? env.DAYTONA_PROBE_IMAGE_NAME;
  if (!digest || !imageName) {
    throw new Error(
      "set --expected-image-ref, or set both --expected-image-digest and --image-name",
    );
  }

  const checkedDigest = requireRealValue("expected-image-digest", digest);
  const checkedImageName = requireRealValue("image-name", imageName);
  if (!IMAGE_DIGEST_RE.test(checkedDigest)) {
    throw new Error("expected-image-digest must be sha256:<64 hex>");
  }
  if (!IMAGE_NAME_RE.test(checkedImageName)) {
    throw new Error("image-name must be a registry/name without whitespace or a digest suffix");
  }

  return `${checkedImageName}@${checkedDigest}`;
}

function parseArgs(argv: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") throw new Error(usage());
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}\n${usage()}`);

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? argv[++index];
    if (!rawKey || !value || value.startsWith("--")) {
      throw new Error(`missing value for --${rawKey || "(unknown)"}\n${usage()}`);
    }
    parsed.set(rawKey, value);
  }
  return parsed;
}

function option(options: Map<string, string>, name: string): string | undefined {
  return options.get(name)?.trim();
}

function requireRealValue(name: string, raw: string | undefined, options: { secret?: boolean } = {}): string {
  const value = raw?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (looksPlaceholder(value)) {
    throw new Error(`${name} is still a placeholder`);
  }
  if (options.secret && value.startsWith("NEXT_PUBLIC_")) {
    throw new Error(`${name} must not be a client-visible variable`);
  }
  return value;
}

function looksPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    /^<[^>]+>$/.test(value) ||
    lower.includes("placeholder") ||
    lower.includes("changeme") ||
    lower.includes("not_a_real") ||
    lower.includes("your-") ||
    lower === "xxx"
  );
}

export function usage(): string {
  return [
    "usage: npm run probe:daytona-sandbox -- --snapshot <snapshot-id-or-name> --expected-image-ref <registry/name@sha256:...>",
    "   or: npm run probe:daytona-sandbox -- --snapshot <snapshot-id-or-name> --image-name <registry/name> --expected-image-digest <sha256:...>",
    "optional: --allowed-snapshot-image-ref <imageName Daytona records on the snapshot> --ttl-minutes <1-60>",
  ].join("\n");
}

export type ToolAvailability = {
  tool: string;
  ok: boolean;
  path: string | null;
};

export function toolCheckCommand(tools: readonly string[] = REQUIRED_TOOLS): string {
  const toolArgs = tools.map(shellQuote).join(" ");
  return [
    `for tool in ${toolArgs}; do`,
    `if command -v "$tool" >/dev/null 2>&1; then printf 'TOOL %s ok %s\\n' "$tool" "$(command -v "$tool")";`,
    `else printf 'TOOL %s missing\\n' "$tool"; fi;`,
    "done",
  ].join(" ");
}

export function parseToolAvailability(output: string): ToolAvailability[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const ok = /^TOOL ([^\s]+) ok (.+)$/.exec(line);
      if (ok) return { tool: ok[1], ok: true, path: ok[2] };
      const missing = /^TOOL ([^\s]+) missing$/.exec(line);
      if (missing) return { tool: missing[1], ok: false, path: null };
      throw new Error(`unparseable tool check line: ${line}`);
    });
}

export type ParsedNetworkProbe = {
  ran: boolean;
  curlExit: number | null;
  status: string | null;
  body: string;
  err: string;
  error?: string;
};

export type NetworkProbeClassification = {
  blocked: boolean;
  reason: "transport_failure" | "daytona_interception_proxy" | "reachable" | "probe_failed";
};

export function networkProbeCommand(probe: NetworkProbe): string {
  const header = probe.header ? `-H ${shellQuote(probe.header)} ` : "";
  return [
    ": > /tmp/bd-capability-probe.body",
    `curl -sS --max-time 8 ${header}-o /tmp/bd-capability-probe.body -w '%{http_code}' ${shellQuote(probe.url)} > /tmp/bd-capability-probe.status 2>/tmp/bd-capability-probe.err`,
    "echo \"PROBE curl_exit=$? status=$(cat /tmp/bd-capability-probe.status)\"",
    "echo \"BODY $(head -c 160 /tmp/bd-capability-probe.body | tr -d '\\n')\"",
    "echo \"ERR $(head -c 160 /tmp/bd-capability-probe.err | tr -d '\\n')\"",
  ].join("; ");
}

export function parseNetworkProbeOutput(result: ExecResult): ParsedNetworkProbe {
  const parsed = /PROBE curl_exit=(\d+) status=(\d*)/.exec(result.result);
  if (result.exitCode !== 0 || !parsed) {
    return {
      ran: false,
      curlExit: null,
      status: null,
      body: "",
      err: "",
      error: `probe command failed with exit ${result.exitCode}`,
    };
  }

  const rawStatus = parsed[2];
  return {
    ran: true,
    curlExit: Number(parsed[1]),
    status: rawStatus === "" || rawStatus === "000" ? null : rawStatus,
    body: /BODY (.*)/.exec(result.result)?.[1]?.trim() ?? "",
    err: /ERR (.*)/.exec(result.result)?.[1]?.trim() ?? "",
  };
}

export function classifyNetworkProbe(parsed: ParsedNetworkProbe): NetworkProbeClassification {
  if (!parsed.ran) return { blocked: false, reason: "probe_failed" };
  if (parsed.curlExit !== 0 && parsed.status === null) {
    return { blocked: true, reason: "transport_failure" };
  }
  if (parsed.status === EGRESS_DENIAL_STATUS && parsed.body.includes(EGRESS_DENIAL_BODY)) {
    return { blocked: true, reason: "daytona_interception_proxy" };
  }
  return { blocked: false, reason: "reachable" };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

import dns from "node:dns/promises";

/**
 * Scope policy for the scope-guard MCP server, ported from Sentinel's `mcp/scope-guard/src/scope.ts`.
 *
 * A target is reachable only if it matches an explicit allow entry. Entries are one of:
 *   - hostname            e.g. juice-shop.local
 *   - IPv4/IPv6 address   e.g. 127.0.0.1
 *   - CIDR range          e.g. 10.0.0.0/24
 *   - wildcard domain     e.g. *.staging.example.com (does NOT match the bare domain)
 *
 * Hard-deny entries can never be reached even if allow-listed (cloud metadata, link-local).
 * This is a deliberate tripwire: an allow entry for them is itself logged as a policy
 * violation at add-time.
 *
 * This class holds no I/O of its own. Sentinel's original read and wrote a JSON file
 * synchronously inside every mutating method; here the same seam that already existed for
 * DNS (`lookup` is injectable) is extended to persistence (`persist` is injectable too), so
 * the adversarial test suite in scope.test.ts needs neither a filesystem nor a database.
 * `lib/scope-guard/scope-profile.ts` is the Drizzle-backed adapter that wires a real
 * `target_profile.scope_rules` row through this seam for the MCP route.
 */

export type TargetClass =
  | "loopback"
  | "private"
  | "link_local"
  | "cloud_metadata"
  | "reserved"
  | "public"
  | "unresolvable_input";

export interface TemporaryEntry {
  entry: string;
  expiresAt: number;
}

export interface ScopeState {
  allow: string[];
  temporary: TemporaryEntry[];
  updatedAt: string;
}

export type ScopeLookup = (host: string) => Promise<{ address: string }[]>;
export type ScopePersist = (state: ScopeState) => Promise<void> | void;

const MAX_TEMPORARY = 5;
const MAX_TTL_MINUTES = 60;

const DEFAULT_ALLOW = ["localhost", "127.0.0.1", "::1"];

/** IPv4 CIDRs that may never appear in the allowlist, directly or via overlap. */
const BANNED_V4_CIDRS = [
  "0.0.0.0/8", // this-network
  "100.64.0.0/10", // CGNAT
  "169.254.0.0/16", // link-local / cloud metadata
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // TEST-NET-1
  "192.88.99.0/24", // 6to4 relay anycast (deprecated)
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // TEST-NET-2
  "203.0.113.0/24", // TEST-NET-3
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved (incl. broadcast)
];

function defaultLookup(host: string): Promise<{ address: string }[]> {
  return dns.lookup(host, { all: true });
}

export function defaultScopeState(): ScopeState {
  return { allow: [...DEFAULT_ALLOW], temporary: [], updatedAt: new Date().toISOString() };
}

/**
 * Same rules as add(), without mutating anything. Used both to validate a fresh add() call
 * and to re-check every persisted entry on load, since a persisted allowlist (hand-edited, or
 * written by an older version of this code) is untrusted input.
 */
function validateEntry(raw: string): string | null {
  const normalized = normalizeEntry(raw);
  if (normalized === null) return "not a valid entry";
  const cls = classify(normalized);
  if (cls === "cloud_metadata") return "cloud metadata endpoint";
  if (cls === "link_local") return "link-local address";
  if (cls === "reserved") return "reserved/non-routable range";
  if (entryHostIncludesSlash(normalized)) {
    for (const banned of BANNED_V4_CIDRS) {
      if (cidrOverlaps(normalized, banned)) return `overlaps hard-denied ${banned}`;
    }
  }
  return null;
}

/**
 * Re-validates every entry in a raw, untrusted state (re-run every add()-time check, drop
 * violations). Returns the sanitized state plus the list of rejected entries, so a caller can
 * decide how to log the quarantine (scope-profile.ts warns and persists the cleaned state
 * back, same as Sentinel's file-backed `load()` did).
 */
export function sanitizeScopeState(raw: {
  allow?: unknown;
  temporary?: unknown;
  updatedAt?: unknown;
}): { state: ScopeState; rejected: string[] } {
  // Whether raw.allow was an array at all - even an empty one - is the only signal that tells
  // "nothing has ever been persisted" (apply the defaults) apart from "someone removed every
  // entry on purpose" (leave it empty). Once the array is present, collapsing it to `[]` below
  // (every entry invalid, or genuinely zero entries) must not be reinterpreted as "uninitialized".
  const rawAllow = raw.allow;
  const allowProvided = Array.isArray(rawAllow);
  const allowInput = allowProvided ? rawAllow.map(String) : [];
  const valid: string[] = [];
  const rejected: string[] = [];
  for (const entry of allowInput) {
    const err = validateEntry(entry);
    if (err) {
      rejected.push(`${entry} (${err})`);
      continue;
    }
    const canonical = normalizeEntry(entry)!;
    if (!valid.includes(canonical)) valid.push(canonical);
  }
  const now = Date.now();
  const temporaryInput = Array.isArray(raw.temporary) ? raw.temporary : [];
  const temporary: TemporaryEntry[] = [];
  for (const t of temporaryInput) {
    if (typeof t !== "object" || t === null) continue;
    const entry = normalizeEntry(String((t as { entry?: unknown }).entry ?? ""));
    const expiresAt = Number((t as { expiresAt?: unknown }).expiresAt);
    if (entry === null || !Number.isFinite(expiresAt) || expiresAt <= now) continue;
    if (classify(entry) !== "public") continue; // temporary entries are public-only, see addTemporary
    temporary.push({ entry, expiresAt });
  }
  return {
    state: {
      // A present-but-empty allow array (scope_remove-ed down to nothing, or an array that
      // quarantined every entry) stays empty. Defaults are only for the case where the caller
      // never had an allow array to begin with.
      allow: valid.length > 0 ? valid : allowProvided ? [] : [...DEFAULT_ALLOW],
      temporary,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    },
    rejected,
  };
}

export class Scope {
  private state: ScopeState;
  private lookup: ScopeLookup;
  private persist: ScopePersist;

  constructor(initial: ScopeState, lookup: ScopeLookup = defaultLookup, persist: ScopePersist = () => {}) {
    this.state = { allow: [...initial.allow], temporary: [...initial.temporary], updatedAt: initial.updatedAt };
    this.lookup = lookup;
    this.persist = persist;
  }

  private async save(): Promise<void> {
    await this.persist(this.state);
  }

  list(): string[] {
    return [...this.state.allow];
  }

  snapshot(): ScopeState {
    return { allow: [...this.state.allow], temporary: [...this.state.temporary], updatedAt: this.state.updatedAt };
  }

  /**
   * Self-expiring entry for autonomous lab-bootstrap flows (package repos, CDNs). Same
   * validation as add(), plus capacity + TTL caps so an agent cannot accumulate a standing
   * widening of the fence.
   */
  async addTemporary(entry: string, ttlMinutes: number): Promise<string | null> {
    const normalized = normalizeEntry(entry);
    if (normalized === null) return `not a valid scope entry: "${entry}"`;
    const cls = classify(normalized);
    if (cls !== "public") return `refused: temporary entries may only be public hosts (got ${cls})`;
    if (!(ttlMinutes > 0) || ttlMinutes > MAX_TTL_MINUTES) {
      return `refused: ttl must be 1-${MAX_TTL_MINUTES} minutes`;
    }
    this.pruneTemporary();
    if (this.state.temporary.length >= MAX_TEMPORARY) {
      return `refused: temporary limit (${MAX_TEMPORARY}) reached - wait for expiry or prune`;
    }
    if (this.state.allow.includes(normalized)) return `"${normalized}" is already permanently scoped`;
    if (this.state.temporary.some((t) => t.entry === normalized)) return `"${normalized}" is already temporarily scoped`;
    this.state.temporary.push({ entry: normalized, expiresAt: Date.now() + ttlMinutes * 60_000 });
    this.state.updatedAt = new Date().toISOString();
    await this.save();
    return null;
  }

  private pruneTemporary(): void {
    const live = this.state.temporary.filter((t) => t.expiresAt > Date.now());
    if (live.length !== this.state.temporary.length) {
      this.state.temporary = live;
      // Fire-and-forget: pruning expired entries is a cleanup, not a mutation a caller is
      // waiting on, and every read path (list/check) already tolerates a stale save.
      void this.save();
    }
  }

  temporaryList(): { entry: string; expiresAt: string }[] {
    this.pruneTemporary();
    return this.state.temporary.map((t) => ({ entry: t.entry, expiresAt: new Date(t.expiresAt).toISOString() }));
  }

  /** Returns error message when the entry is refused, null when accepted. */
  async add(entry: string): Promise<string | null> {
    const normalized = normalizeEntry(entry);
    if (normalized === null) return `not a valid scope entry: "${entry}"`;
    const cls = classify(normalized);
    if (cls === "cloud_metadata") {
      return `refused: cloud metadata endpoints are hard-denied and cannot be allow-listed`;
    }
    if (cls === "link_local") {
      return `refused: link-local space (169.254.0.0/16, fe80::/10) is hard-denied and cannot be allow-listed`;
    }
    if (cls === "reserved") {
      return `refused: reserved/non-routable ranges are hard-denied and cannot be allow-listed`;
    }
    // A CIDR that overlaps link-local or metadata space would silently authorize those
    // addresses through a seemingly innocuous range.
    if (entryHostIncludesSlash(normalized)) {
      for (const banned of BANNED_V4_CIDRS) {
        if (cidrOverlaps(normalized, banned)) {
          return `refused: CIDR ${normalized} overlaps hard-denied ${banned}`;
        }
      }
    }
    if (this.state.allow.includes(normalized)) return `"${normalized}" is already scoped`;
    this.state.allow.push(normalized);
    this.state.updatedAt = new Date().toISOString();
    await this.save();
    return null;
  }

  async remove(entry: string): Promise<boolean> {
    const normalized = normalizeEntry(entry);
    if (normalized === null) return false;
    const beforeAllow = this.state.allow.length;
    this.state.allow = this.state.allow.filter((e) => e !== normalized);
    const beforeTemp = this.state.temporary.length;
    this.state.temporary = this.state.temporary.filter((t) => t.entry !== normalized);
    if (this.state.allow.length !== beforeAllow || this.state.temporary.length !== beforeTemp) {
      this.state.updatedAt = new Date().toISOString();
      await this.save();
      return true;
    }
    return false;
  }

  /**
   * Async because public hostnames are DNS-resolved at check time: an allow-listed name that
   * resolves into private/link-local space is treated as a DNS-rebinding attempt and denied.
   * IP-literal targets, CIDR entries and unresolvable names skip resolution (fail-closed on
   * the last case).
   */
  async check(target: string): Promise<{
    allowed: boolean;
    reason: string;
    target_class: TargetClass;
    matched?: string;
    /**
     * The exact address a caller should dial when `allowed` is true: the resolved IP for a
     * hostname entry, or the target's own host when it was already an IP literal / CIDR
     * match (no resolution happened). Connecting to anything else - i.e. letting the HTTP or
     * TCP client re-resolve the hostname itself - reopens the DNS-rebinding window this check
     * just closed, since a second, independent lookup can answer differently from this one.
     */
    connectAddress?: string;
  }> {
    const normalized = normalizeTarget(target);
    if (normalized === null) {
      return { allowed: false, reason: `unparseable target "${target}"`, target_class: "unresolvable_input" };
    }
    const cls = classify(normalized.value);
    if (cls === "cloud_metadata") {
      return { allowed: false, reason: "HARD DENY: cloud metadata endpoint", target_class: cls };
    }
    if (cls === "link_local") {
      return { allowed: false, reason: "HARD DENY: link-local address", target_class: cls };
    }
    if (cls === "reserved") {
      return { allowed: false, reason: "HARD DENY: reserved/non-routable address", target_class: cls };
    }

    this.pruneTemporary();
    let matched: string | undefined;
    for (const entry of this.state.allow) {
      if (matches(entry, normalized)) {
        matched = entry;
        break;
      }
    }
    if (!matched) {
      for (const t of this.state.temporary) {
        if (matches(t.entry, normalized)) {
          matched = t.entry;
          break;
        }
      }
    }
    if (!matched) {
      return {
        allowed: false,
        reason: `no scope entry matches "${normalized.display}" - add it via scope_add or pick an in-scope target`,
        target_class: cls,
      };
    }

    const host = splitHostPort(normalized.value).host;
    const entryHost = splitHostPort(matched).host;
    const needsResolution = !isIP(host) && !entryHost.includes("/");
    if (!needsResolution) {
      // host is already an IP literal (or matched via CIDR), so there is nothing to pin: no
      // hostname resolution happened for a rebinding attack to land in between.
      return { allowed: true, reason: `matches scoped entry "${matched}"`, target_class: cls, matched, connectAddress: host };
    }

    let addresses: string[];
    try {
      addresses = (await this.lookup(host))
        .map((a) => a.address)
        .filter((a) => typeof a === "string" && a.length > 0);
    } catch {
      return {
        allowed: false,
        reason: `fail-closed: scoped hostname "${host}" did not resolve`,
        target_class: "unresolvable_input",
        matched,
      };
    }
    if (addresses.length === 0) {
      return {
        allowed: false,
        reason: `fail-closed: scoped hostname "${host}" resolved to zero usable addresses`,
        target_class: "unresolvable_input",
        matched,
      };
    }

    const resolvedClasses = new Set(addresses.map((a) => classify(a)));
    if (resolvedClasses.has("cloud_metadata")) {
      return {
        allowed: false,
        reason: `DNS rebinding guard: "${host}" resolves to a cloud metadata address (${addresses.join(", ")})`,
        target_class: "cloud_metadata",
        matched,
      };
    }
    if (resolvedClasses.has("link_local") || resolvedClasses.has("reserved")) {
      return {
        allowed: false,
        reason: `DNS rebinding guard: "${host}" resolves to link-local/reserved space (${addresses.join(", ")})`,
        target_class: "link_local",
        matched,
      };
    }
    // Public-scoped names must not silently become internal targets...
    if (cls === "public" && (resolvedClasses.has("private") || resolvedClasses.has("loopback"))) {
      return {
        allowed: false,
        reason: `DNS rebinding guard: public-scoped "${host}" resolves to private address (${addresses.join(", ")}) - scope the IP/CIDR explicitly instead`,
        target_class: "private",
        matched,
      };
    }
    // ...and internally-scoped names must not silently become public ones.
    if ((cls === "private" || cls === "loopback") && resolvedClasses.has("public")) {
      return {
        allowed: false,
        reason: `class mismatch guard: "${cls}"-scoped "${host}" resolves to public address (${addresses.join(", ")})`,
        target_class: "public",
        matched,
      };
    }
    // The exact address just validated above - not a fresh lookup a caller might do later,
    // which is the whole point (see the connectAddress doc comment on check()'s return type).
    return { allowed: true, reason: `matches scoped entry "${matched}"`, target_class: cls, matched, connectAddress: addresses[0] };
  }
}

function normalizeEntry(entry: string): string | null {
  const s = entry.trim();
  if (s.length === 0 || s.length > 253) return null;
  if (/^\*\.[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)) return s.toLowerCase(); // wildcard domain
  const cidr = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(s);
  if (cidr) {
    const octets = cidr.slice(1, 5).map(Number);
    const bits = Number(cidr[5]);
    if (octets.every((o) => o <= 255) && bits <= 32) return s; // strict IPv4 CIDR
    return null;
  }
  // IPv6 literal, optionally bracketed and with a port: "::1", "[::1]", "[::1]:8080".
  // Bracketed entries keep their port ("[v6]:p"); bare v6 stores no port
  // (unbracketed v6-with-port is ambiguous and rejected).
  const bracketed = /^\[([0-9a-f:]+)\](?::(\d{1,5}))?$/i.exec(s);
  if (bracketed) {
    if (!parseIPv6(bracketed[1])) return null;
    const base = canonicalV6(bracketed[1].toLowerCase());
    if (bracketed[2] !== undefined) {
      const p = Number(bracketed[2]);
      if (p < 1 || p > 65535) return null;
      return `[${base}]:${p}`;
    }
    return base;
  }
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(s)) return s.toLowerCase(); // mapped-v6 dotted
  if (/^[0-9a-f:]+$/i.test(s) && (s.match(/:/g)?.length ?? 0) >= 2) {
    return canonicalV6(s.toLowerCase());
  }
  if (/^[\w.-]+:\d{1,5}$/i.test(s)) {
    const p = Number(s.match(/:(\d{1,5})$/)![1]);
    if (p < 1 || p > 65535) return null;
    return s.toLowerCase();
  }
  if (/^[\w.-]+$/i.test(s)) return s.toLowerCase(); // host
  return null;
}

function isIP(host: string): boolean {
  return isIPv4(host) || host.includes(":");
}

function entryHostIncludesSlash(entry: string): boolean {
  return entry.includes("/");
}

/** True when two IPv4 CIDRs share at least one address. */
function cidrOverlaps(a: string, b: string): boolean {
  const toInt = (s: string): number => s.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  const [aBase, aBits] = a.split("/");
  const [bBase, bBits] = b.split("/");
  const mask = (bits: number): number => (bits === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0);
  const aI = toInt(aBase),
    bI = toInt(bBase);
  const m = Number(aBits) <= Number(bBits) ? mask(Number(aBits)) : mask(Number(bBits));
  return (aI & m) === (bI & m);
}

/** Public wrapper for canonical host[:port] normalization used by grant bookkeeping. */
export function normalizeTargetValue(target: string): string | null {
  const n = normalizeTarget(target);
  return n ? n.value : null;
}

function normalizeTarget(target: string): { value: string; display: string } | null {
  const s = target.trim().toLowerCase();
  if (s.length === 0) return null;
  try {
    const url = new URL(s.includes("://") ? s : `http://${s}`);
    const port = url.port ? `:${url.port}` : "";
    const host = url.hostname;
    if (host.length === 0) return null;
    return { value: `${host}${port}`, display: `${host}${port}${url.pathname === "/" ? "" : url.pathname}` };
  } catch {
    return null;
  }
}

/** Decode an IPv4-mapped IPv6 literal (dotted or hex tail) to plain IPv4, else null. */
function unwrapMappedV6(host: string): string | null {
  const m = /^::ffff:(.+)$/i.exec(host);
  if (!m) return null;
  const tail = m[1];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** Parse an IPv6 literal (no brackets/port/zone) into its 8 hextet groups, else null. */
export function parseIPv6(s: string): number[] | null {
  if (!s.includes(":") || !/^[0-9a-f:.]+$/i.test(s)) return null;
  const doubleColons = s.match(/::/g)?.length ?? 0;
  if (doubleColons > 1) return null;
  // Embedded dotted-quad tails ("x:x:x:x:x:x:1.2.3.4") are rejected here; mapped-v6 must
  // arrive in ::ffff: form and is unwrapped earlier.
  const parts = s.split(":");
  if (parts.some((p) => p.includes("."))) return null; // embedded v4 tail rejected
  let head: string[] = parts;
  let tail: string[] = [];
  if (doubleColons === 1) {
    const idx = s.indexOf("::");
    const headStr = s.slice(0, idx);
    const tailStr = s.slice(idx + 2);
    head = headStr === "" ? [] : headStr.split(":");
    tail = tailStr === "" ? [] : tailStr.split(":");
    if (head.some((p) => p === "") || tail.some((p) => p === "")) return null;
  }
  if (head.length + tail.length > 8) return null;
  const missing = 8 - (head.length + tail.length);
  if (!s.includes("::") && missing !== 0) return null;
  if (![...head, ...tail].every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null; // hextets max ffff
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail].map((g) => parseInt(g || "0", 16));
  return groups.some((g) => Number.isNaN(g)) ? null : groups;
}

/** Canonical lowercase form of an IPv6 literal ("0:0:..:1" -> "::1"), or the input unchanged. */
export function canonicalV6(host: string): string {
  const g = parseIPv6(host);
  if (!g) return host;
  // RFC 5952-style: first longest zero run becomes "::"
  let bestStart = -1,
    bestLen = 0,
    curStart = -1,
    curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (g[i] === 0) {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 2) return g.map((n) => n.toString(16)).join(":");
  const head = g
    .slice(0, bestStart)
    .map((n) => n.toString(16))
    .join(":");
  const tail = g
    .slice(bestStart + bestLen)
    .map((n) => n.toString(16))
    .join(":");
  return `${head}::${tail}`;
}

function classify(hostPort: string): TargetClass {
  let host = splitHostPort(hostPort).host;
  // IPv4-mapped IPv6 ("::ffff:169.254.169.254", "::ffff:a9fe:a9fe") must be judged by its
  // embedded IPv4 address, otherwise it sails past every v4 tripwire as "public". Hex tails
  // we cannot decode are treated as reserved.
  const mappedTail = /^::ffff:/i.test(host) ? unwrapMappedV6(host) : null;
  if (/^::ffff:/i.test(host)) {
    if (mappedTail === null) return "reserved";
    host = mappedTail;
  }
  if (host === "169.254.169.254" || host === "metadata.google.internal") return "cloud_metadata";
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (isIPv4(host)) {
    const [a, b, c] = host.split(".").map(Number);
    if (a === 127) return "loopback";
    if (a === 169 && b === 254) return "link_local";
    if (a === 0 || a >= 224) return "reserved"; // this-network, multicast, reserved
    if (a === 100 && b >= 64 && b <= 127) return "reserved"; // CGNAT 100.64.0.0/10
    if (a === 198 && (b === 18 || b === 19)) return "reserved"; // benchmarking 198.18.0.0/15
    if (a === 192 && b === 0 && c === 2) return "reserved"; // TEST-NET-1
    if (a === 198 && b === 51) return "reserved"; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return "reserved"; // TEST-NET-3
    if (a === 192 && b === 88 && c === 99) return "reserved"; // 192.88.99.0/24
    if (a === 192 && b === 0 && c === 0) return "reserved"; // 192.0.0.0/24 IETF protocol assignments
    if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return "private";
    return "public";
  }
  if (host.includes(":")) {
    const g = parseIPv6(host);
    if (!g) return "reserved"; // colon-string we cannot parse: fail closed
    if (g.every((n) => n === 0)) return "reserved"; // unspecified ::/128
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) {
      return "loopback";
    }
    if ((g[0] & 0xffc0) === 0xfe80) return "link_local"; // fe80::/10
    if ((g[0] & 0xfe00) === 0xfc00) return "private"; // fc00::/7 ULA
    if (g[0] >= 0xff00) return "reserved"; // multicast ff00::/8 and beyond
    if (g[0] === 0x2001 && g[1] === 0x0db8) return "reserved"; // documentation
    return "public";
  }
  return /\.local$/.test(host) ? "private" : "public";
}

/**
 * Whether a target classifies as loopback (localhost, 127.0.0.0/8, ::1). Every grant is
 * single-use regardless of target; this only feeds an audit-log flag (see
 * request_intrusive_approval in the MCP route) so a reviewer can tell a loopback grant from
 * one against a real host at a glance.
 */
export function isLoopbackTarget(target: string): boolean {
  return classify(normalizeTargetValue(target) ?? target) === "loopback";
}

/**
 * Split host[:port] without mangling IPv6 literals ("::1" is a host, not "host : port").
 * Bracketed forms "[::1]" / "[::1]:8080" are unwrapped.
 */
export function splitHostPort(s: string): { host: string; port?: string } {
  const x = s.trim();
  if (x.startsWith("[")) {
    const close = x.indexOf("]");
    if (close !== -1) {
      const host = x.slice(1, close);
      const port = x.slice(close + 1).match(/^:(\d{1,5})$/)?.[1];
      return { host, port };
    }
  }
  if (/^[0-9a-f:]+$/i.test(x) && (x.match(/:/g)?.length ?? 0) >= 2) return { host: canonicalV6(x.toLowerCase()) }; // bare IPv6
  const m = /^([\w.-]+):(\d{1,5})$/.exec(x);
  if (m) return { host: m[1].toLowerCase(), port: m[2] };
  return { host: x.toLowerCase() };
}

function isIPv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255);
}

function matches(entry: string, target: { value: string }): boolean {
  // v6 targets come through URL.hostname bracketed ("[::1]:80"); entries are stored bare.
  const { host, port } = splitHostPort(target.value);
  const { host: entryHost, port: entryPort } = splitHostPort(entry);

  if (entryHost.includes("/")) return isIPv4(host) && cidrContains(entryHost, host); // CIDR
  if (entryHost.startsWith("*.")) {
    const suffix = entryHost.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return entryHost === host && (entryPort === undefined || entryPort === port);
}

function cidrContains(cidr: string, ip: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const toInt = (s: string): number => s.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(base) & mask) === (toInt(ip) & mask);
}

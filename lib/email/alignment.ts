/**
 * Does the sender's authentication actually vouch for the From address?
 *
 * Resend's `authentication.spf` and `.dkim` say that some SPF check and some DKIM signature
 * passed, not for which domain. SPF covers the envelope sender (Return-Path) and a DKIM signature
 * can come from any domain, so attacker.com can pass both while writing `From: victim@bigcorp.com`.
 * Replying to that From would mail our acknowledgement, and later a verdict, to the victim. So an
 * outside sender is accepted only when the receiving MX's own Authentication-Results says the
 * From domain is aligned: `dmarc=pass` for it, or `dkim=pass` from an aligned signing domain.
 *
 * The receiving MX is Amazon SES behind Resend. What it adds, seen on real inbound mail:
 *
 *   Return-Path, Received, X-SES-Spam-Verdict, X-SES-Virus-Verdict, Received-SPF,
 *   Authentication-Results: amazonses.com; spf=pass (...) envelope-from=...; dkim=pass
 *     header.i=@<domain>; dmarc=pass header.from=<domain>;
 *   X-SES-RECEIPT, X-SES-DKIM-SIGNATURE
 *
 * and then the sender's own headers. A sender can put any header in its message, including an
 * Authentication-Results naming amazonses.com, but it lands below that block because the MX
 * prepends. So only an Authentication-Results above the first X-SES-RECEIPT is trusted, and
 * everything fails closed: no receipt, no trusted result, or no aligned pass means no admission.
 *
 * Resend's parsed `headers` object cannot be used for this. It keeps one value per header name
 * (the raw message had two Received lines, the object one), so a forged duplicate could stand in
 * for the real one. This reads the raw header block instead.
 */
export const TRUSTED_AUTHSERV_ID = "amazonses.com";
const RECEIPT_HEADER = "x-ses-receipt";

/**
 * ponytail: organisational domain by "last two labels", or last three under a known two-part
 * public suffix. Not the Public Suffix List. The ceiling: under a two-part suffix missing from this
 * list, every registrant collapses to the same organisational domain, so a DKIM pass from
 * attacker.gov.xx would align with victim.gov.xx. The DMARC path is unaffected (it needs an exact
 * header.from match). Swap in the Public Suffix List if that gap matters.
 */
const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "net.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp",
  "co.in", "net.in", "org.in", "gov.in", "ac.in",
  "com.br", "net.br", "org.br",
  "com.cn", "net.cn", "org.cn",
  "co.za", "org.za",
  "com.mx", "com.ar", "com.tr", "com.sg", "com.hk", "com.tw", "com.my",
  "co.kr", "or.kr", "co.il", "co.id",
]);

export function organisationalDomain(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return TWO_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/** DMARC relaxed alignment: the same organisational domain. */
export function aligned(a: string, b: string): boolean {
  if (!a || !b) return false;
  return organisationalDomain(a) === organisationalDomain(b);
}

type Header = { name: string; value: string };

/** The header section of a raw message, unfolded, in order. */
export function parseHeaderBlock(raw: string): Header[] {
  const block = raw.split(/\r?\n\r?\n/)[0] ?? "";
  return block
    .split(/\r?\n(?![ \t])/)
    .map((line) => {
      const colon = line.indexOf(":");
      if (colon <= 0) return null;
      return {
        name: line.slice(0, colon).trim().toLowerCase(),
        value: line.slice(colon + 1).replace(/\r?\n[ \t]+/g, " ").trim(),
      };
    })
    .filter((h): h is Header => h !== null);
}

type MethodResult = { method: string; result: string; props: Record<string, string> };

/** Split an Authentication-Results value into its authserv-id and method results. */
export function parseAuthenticationResults(value: string): { authservId: string; results: MethodResult[] } {
  // Comments carry prose like "domain of x designates y"; they are never part of a result.
  const clean = value.replace(/\([^)]*\)/g, " ");
  const [authserv, ...segments] = clean.split(";");
  const results: MethodResult[] = [];
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const head = tokens[0]?.match(/^([a-z0-9-]+)=([a-z]+)$/i);
    if (!head) continue;
    const props: Record<string, string> = {};
    for (const token of tokens.slice(1)) {
      const prop = token.match(/^([a-z0-9-]+\.[a-z0-9-]+)=(.+)$/i);
      if (prop) props[prop[1].toLowerCase()] = prop[2].replace(/^"|"$/g, "").toLowerCase();
    }
    results.push({ method: head[1].toLowerCase(), result: head[2].toLowerCase(), props });
  }
  return { authservId: (authserv ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "", results };
}

/** The domain a DKIM result speaks for: header.d, or the domain part of header.i. */
function dkimDomain(props: Record<string, string>): string {
  if (props["header.d"]) return props["header.d"];
  const identity = props["header.i"] ?? "";
  return identity.includes("@") ? identity.slice(identity.lastIndexOf("@") + 1) : identity;
}

export type AlignmentVerdict = { ok: true; via: "dmarc" | "dkim" } | { ok: false; reason: string };

/**
 * Check the raw header block of a received message against its From domain. `fromDomain` is the
 * domain of the address intake will store and reply to.
 */
export function checkFromAlignment(rawHeaders: string, fromDomain: string): AlignmentVerdict {
  const headers = parseHeaderBlock(rawHeaders);
  const receipt = headers.findIndex((h) => h.name === RECEIPT_HEADER);
  if (receipt < 0) return { ok: false, reason: "no receiving-MX receipt header" };

  const trusted = headers.slice(0, receipt).find((h) => h.name === "authentication-results");
  if (!trusted) return { ok: false, reason: "no Authentication-Results from the receiving MX" };
  const { authservId, results } = parseAuthenticationResults(trusted.value);
  if (authservId !== TRUSTED_AUTHSERV_ID) {
    return { ok: false, reason: `Authentication-Results is from ${authservId || "nobody"}, not the receiving MX` };
  }

  const from = fromDomain.toLowerCase();
  // DMARC's header.from is the domain it evaluated. A pass for some other domain says nothing
  // about this From, so it must name ours exactly.
  if (results.some((r) => r.method === "dmarc" && r.result === "pass" && r.props["header.from"] === from)) {
    return { ok: true, via: "dmarc" };
  }
  if (results.some((r) => r.method === "dkim" && r.result === "pass" && aligned(dkimDomain(r.props), from))) {
    return { ok: true, via: "dkim" };
  }
  return { ok: false, reason: `no DMARC or aligned DKIM pass for ${from}` };
}

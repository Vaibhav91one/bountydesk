# Research: Live Target Ownership Verification (#325)

Issue #325 asks for a path that verifies a customer owns a live web host before running authorized security checks, distinct from the current build-a-target-then-reproduce model. This file compares how six products handle ownership proof, re-verification, scope pinning, rate limits, and allow-lists, and maps the findings onto BountyDesk's Q33 design.

## 1. How current products handle live-target ownership

### 1.1 Google Search Console

The verification page at [support.google.com/webmasters/answer/9008080](https://support.google.com/webmasters/answer/9008080) lists five verification methods: HTML file upload, HTML tag, Google Analytics tracking code, Google Tag Manager, and Google Sites or Blogger account. The "Domain name provider" method (adding a DNS TXT or CNAME record) is the only option that verifies a Domain property (example.com), as opposed to URL-prefix properties (https://example.com).

The page states: "Verification lasts as long as Search Console can confirm the presence and validity of your verification token. Search Console periodically checks if your verification token is still present and valid. If verification can no longer be confirmed, you will be notified." No fixed TTL or re-verification interval is documented.

### 1.2 HackerOne (asset inventory + scoping)

HackerOne treats each asset (hostname or domain) as an independently scoped target. Targets are added as a domain or sub-domain through the asset form, and the scope rule is stored server-side as structured JSON on the asset record. The asset-detail page is at [docs.hackerone.com/en/articles/8583355](https://docs.hackerone.com/en/articles/8583355), and the asset-types reference is at [docs.hackerone.com/en/articles/8486269](https://docs.hackerone.com/en/articles/8486269).

The platform does not perform a DNS TXT or well-known file proof. Ownership is established by the human accepting the asset into the program. Traffic on Gateway is attributed per-asset, which serves as runtime enforcement of scope boundaries. Re-verification is a manual process: the program owner must re-add or edit the asset.

### 1.3 Burp Suite DAST (Enterprise)

Burp DAST derives site scope from start URLs. The scope is the root domain plus any in-scope URL prefixes an operator adds explicitly. Subdomains are not included by default and must be listed separately. The site-scope documentation is at [portswigger.net/burp/documentation/dast/user-guide/scanning-web-apps/setting-site-scope](https://portswigger.net/burp/documentation/dast/user-guide/scanning-web-apps/setting-site-scope).

There is no ownership proof mechanism. Scope is a server-side configuration stored in the target record. Network/firewall rules are documented at [portswigger.net/burp/documentation/dast/user-guide/reference/network-firewall-rules](https://portswigger.net/burp/documentation/dast/user-guide/reference/network-firewall-rules): the scanner needs inbound access from PortSwigger's scanner IPs, and outbound access to `*.oastify.com` on ports 80 and 443. No automated re-verification occurs.

### 1.4 Intruder

Targets are external IP addresses, domains, or sub-domains, added through the Intruder portal. The targets page is at [help.intruder.io/en/articles/2946211](https://help.intruder.io/en/articles/2946211). There is no DNS TXT or well-known file proof mechanism documented. Ownership is established when the customer adds a target they control.

Scanner IPs must be allow-listed on the target's firewall. The full list is at [help.intruder.io/en/articles/1635683](https://help.intruder.io/en/articles/1635683): all plans allow `64.52.19.0/24`, and Pro, Enterprise, and Vanguard plans also allow regional ranges. WAF detection flags interference in the scan results, scan settings page, and target detail page.

Licensing is tied to a 30-day consumption cycle. The license FAQ at [help.intruder.io/en/articles/1346333](https://help.intruder.io/en/articles/1346333) states: "the license can only be removed once the license has been released (the configuration on the target has been removed, and it has not been scanned for 30 days)."

### 1.5 Tenable Web App Scanning

Targets are specified as URLs (starting with `http://` or `https://`) in the scan configuration. The basic settings page at [docs.tenable.com/web-app-scanning/Content/WAS/Scans/BasicSettings.htm](https://docs.tenable.com/web-app-scanning/Content/WAS/Scans/BasicSettings.htm) shows the target field accepts a URL or an imported TXT file (one URL per line, 1MB max). Regular expressions and wildcards are not allowed.

The allowlist page at [docs.tenable.com/web-app-scanning/Content/WAS/allowlist.htm](https://docs.tenable.com/web-app-scanning/Content/WAS/allowlist.htm) lists files and processes that must be permitted in endpoint security software. Cloud sensor IPs for allow-list purposes are at [docs.tenable.com/web-app-scanning/Content/Settings/Sensors/CloudSensors.htm](https://docs.tenable.com/web-app-scanning/Content/Settings/Sensors/CloudSensors.htm), which provides regional scanner IP ranges in CIDR notation.

There is no DNS TXT or well-known file proof mechanism documented. Ownership is established through the Tenable One license model: the target URL must match a licensed application, and adding a URL with a different FQDN counts as an additional licensed asset.

### 1.6 Detectify

**Unable to verify.** The Detectify asset-verification page ([docs.detectify.com/getting-started/asset-verification](https://docs.detectify.com/getting-started/asset-verification)) returned content, but the body text was truncated on fetch. The "Adding Assets" page ([docs.detectify.com/getting-started/adding-assets](https://docs.detectify.com/getting-started/adding-assets)) returned only navigation, no article body. No verifiable claim can be made about Detectify's ownership proof mechanism.

## 2. Comparison table

| Product | Proof type | Re-check cadence | Scope pinning | Rate limits | Allow-list IPs |
|---|---|---|---|---|---|
| Google Search Console | DNS TXT, HTML file, meta tag, GA, GTM (unverified for this product) | Periodic, grace-period expiry, no fixed TTL | Domain or URL-prefix property | Not documented | Google Site Verifier UA |
| HackerOne | None - human-accepted asset record | Manual (re-edit/re-add) | Per-asset hostname/domain record | Not documented | Gateway traffic attributed per asset |
| Burp Suite DAST | None - server-side start-URL config | Never | Start URLs derive scope, subdomains excluded | Not documented | Scanner IPs from PortSwigger infra, egress to `*.oastify.com` |
| Intruder | None - human-added target | Manual | External IP, domain, or sub-domain | Not documented | `64.52.19.0/24` plus regional ranges |
| Tenable WAS | None - licensed URL target | Manual | URL prefix scope via Tenable One console/API | Not documented | Regional cloud sensor IP ranges |
| Detectify | (unverified) | (unverified) | (unverified) | (unverified) | (unverified) |

Five of six products are fully verified with citations above. Detectify could not be confirmed because the docs pages returned truncated or navigation-only content.

## 3. Fit with BountyDesk's Q33 design

Q33 (`docs/decisions.md` lines 999-1046) specifies a `TargetProfile` with an ownership proof stored in the `config jsonb` column of `target_profile` (`lib/db/schema.ts`, L266-317). The proof uses either a DNS TXT record `bountydesk-verification=<token>` or a `/.well-known/bountydesk.txt` file token, re-checked before every run with a 30-day expiry. The `ExternalTargetConfig` type in `lib/targets/external-target.ts` already has `baseUrl`, `egressHosts`, and `seedable`. The proof token, expiry timestamp, and resolved address would live in `config`.

The runtime path maps cleanly onto existing files:

- `lib/targets/configure.ts` (`configureConnectionlessTarget`) is where the proof would be set up and stored in `config`.
- `lib/targets/quarantine.ts` (`quarantineStaleTargetProfile`) would handle the expired-proof case, dropping reports to `ANALYSIS_ONLY`.
- `lib/mcp/probe-target.ts` and `app/api/mcp/scope-guard/route.ts` are where the probe happens, and they already read `config.baseUrl`. The ownership proof field would be read here for pre-run validation.
- `lib/agent-sessions/poller.ts` (`autoApproveWriteProbe`) already gates POST probes to sandbox-local scope. The ownership re-check would run before this gate, not after.

The gap against current products: four of the five verified products (HackerOne, Burp DAST, Intruder, Tenable WAS) perform no automated ownership re-verification at all. Google Search Console is the only one with a periodic re-check, but its cadence is undefined and not tied to each scan. BountyDesk's design is strictly stronger by requiring re-verification before every run, which is appropriate given the security-check purpose of the tool.

## 4. Risks and open questions

- **Well-known path spoofing**: a `/.well-known/bountydesk.txt` file can be served by any CDN or proxy in front of the target. The proof should also resolve the address and reject loopback, metadata-range, or private IPs before accepting the token (Q33 notes this is a separate DNS-rebinding defense).
- **DNS rebinding during re-verification**: if the target's IP changes between the ownership proof and the probe, the proof is stale. The resolve-and-pin step in `lib/targets/external-target.ts` already rejects loopback. It should also cache the resolved address alongside the proof and invalidate on mismatch.
- **30-day expiry is arbitrary**: Google Search Console does not use a fixed TTL. If 30 days is too short, customers will hit false "proof expired" blocks. If too long, a host that changed hands stays green too long. No surveyed product uses a 30-day window as the documented standard for security-check authorization.
- **Rate-limit the re-verification checks**: if the scanner runs frequently, repeated DNS TXT lookups or well-known fetch attempts could themselves look like an attack. None of the surveyed products document client-side rate limits for the verification probe itself.
- **Write-probe interaction**: Q33 states that write-probe auto-approve does not extend the ownership proof. This means a POST that succeeds does not re-prove ownership. The proof must be checked again at the start of the next run. This is stricter than all surveyed products and is a sound safety property, but it should be documented in the canary oracle flow in `lib/sandbox/provision.ts`.

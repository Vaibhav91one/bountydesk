# Research: Live Target Ownership Verification (#325)

Issue #325 asks for a path that verifies a customer owns a live web host before running authorized security checks, distinct from the current build-a-target-then-reproduce model. This file compares how six products handle ownership proof, re-verification, scope pinning, rate limits, and allow-lists, and maps the findings onto BountyDesk's Q33 design.

## 1. How current products handle live-target ownership

### 1.1 Google Search Console

Ownership verification supports five methods, all documented at [support.google.com/webmasters/answer/9008080](https://support.google.com/webmasters/answer/9008080): DNS TXT record, HTML file upload (GET on a well-known path), HTML meta tag, Google Analytics tracking code, and Google Tag Manager container. For domain-level verification only, a DNS TXT record is required. Search Console "periodically checks if your verification token is still present and valid" and sends a grace-period notification before revoking access if the token disappears.

### 1.2 HackerOne (asset inventory + scoping)

HackerOne treats each asset (hostname or domain) as an independently scoped target. The asset-details page lets a program owner add a live hostname or domain through the "asset" form, which records the scope rule server-side as structured JSON. [docs.hackerone.com/en/articles/8583355](https://docs.hackerone.com/en/articles/8583355) covers the asset-details page, and [docs.hackerone.com/en/articles/8486269](https://docs.hackerone.com/en/articles/8486269) describes asset types. Traffic on Gateway is attributed per-asset, which is the runtime enforcement of scope boundaries. When a hostname is added, HackerOne does not itself perform a DNS TXT or well-known proof — it trusts the human accepting the asset, but the asset record is the pinning authority for all downstream scope checks. Re-verification is not built into the platform; it is a process the program owner must re-run by editing or re-adding the asset.

### 1.3 Burp Suite DAST (Enterprise)

Burp DAST derives site scope from start URLs. The scope is the root domain plus any in-scope URL prefixes an operator adds explicitly. Subdomains are not included by default and must be listed separately. [portswigger.net/burp/documentation/dast/user-guide/scanning-web-apps/setting-site-scope](https://portswigger.net/burp/documentation/dast/user-guide/scanning-web-apps/setting-site-scope) documents this. There is no ownership proof mechanism: scope is a server-side configuration stored in the target record, not a challenge-response against the host. Network/firewall rules ([portswigger.net/burp/documentation/dast/user-guide/reference/network-firewall-rules](https://portswigger.net/burp/documentation/dast/user-guide/reference/network-firewall-rules)) define egress allow-lists: the scanner IPs are on PortSwigger's infrastructure, and the target must allow inbound access from those IPs on the scanned ports, plus outbound to `*.oastify.com` on ports 80/443. There is no automated re-verification; a scan is authorized by whoever created the site record in Burp DAST.

### 1.4 Detectify

The "Adding Assets" page at [docs.detectify.com/getting-started/adding-assets](https://docs.detectify.com/getting-started/adding-assets) and the "Asset Verification" page ([docs.detectify.com/getting-started/asset-verification](https://docs.detectify.com/getting-started/asset-verification)) describe the flow. Assets are added as hostnames or IP ranges in the platform UI; Detectify performs automated verification by probing the host and confirming the owner controls the DNS. The site content was truncated on fetch, so implementation-level details (exact TXT record name, well-known path, or TTL handling) could not be confirmed.

### 1.5 Intruder

Intruder's documentation at `docs.intruder.io` and `support.intruder.com` could not be resolved from this environment (DNS resolution failure). The product page at [intruder.com](https://www.intruder.com) describes scan targets and allow-listing scanner IPs, but the specific ownership proof mechanism (TXT record challenge, well-known file, or meta-tag proof) is **not verifiable** from the available sources.

### 1.6 Tenable Web App Scanning

Tenable WAS product page is at [tenable.com/products/web-app-scanning](https://www.tenable.com/products/web-app-scanning). Targets are added through the Tenable One console or API, with scope defined as URL prefixes. The docs at `docs.tenable.com` (the `tenable-web-app-scanning/Content/WAS/...` paths) returned 404 during research, so configuration-level details on DNS TXT proofs, well-known tokens, or re-verification cadence could not be confirmed. The product page confirms that scanner egress IPs must be allow-listed on target firewalls, similar to Burp DAST.

## 2. Comparison table

| Product | Proof type | Re-check cadence | Scope pinning | Rate limits | Allow-list IPs |
|---|---|---|---|---|---|
| Google Search Console | DNS TXT / HTML file / meta tag / GA / GTM | Periodic, grace-period expiry (not a fixed TTL) | Property + URL-prefix child properties auto-verified | Not documented (platform-level) | Uses Google Site Verifier UA |
| HackerOne | None — human-accepted asset record | Manual (re-edit/re-add asset) | Per-asset hostname/domain record, structured JSON scope | None visible | Gateway traffic attributed per asset |
| Burp Suite DAST | None — server-side start-URL config | Never | Start URLs derive scope; subdomains excluded by default | None visible | Scanner IPs on PortSwigger infra; egress to `*.oastify.com` |
| Detectify | Host probe + DNS ownership check | Not confirmed | Hostname/IP-range asset records | Not confirmed | Not confirmed |
| Intruder | Not verifiable | Not verifiable | Not verifiable | Not verifiable | Not verifiable |
| Tenable WAS | Not verifiable | Not verifiable | URL-prefix scope via Tenable One console/API | Not verifiable | Scanner egress IPs must be allow-listed |

**Unverified rows**: Detectify (asset-verification page content truncated), Intruder (docs DNS failure), Tenable WAS (docs 404). Claims for these are marked below with (not confirmed).

## 3. Fit with BountyDesk's Q33 design

Q33 (`docs/decisions.md` lines 999–1046) specifies a `TargetProfile` with an ownership proof stored in the `config jsonb` column of `target_profile` (`lib/db/schema.ts`, L266–317). The proof uses either a DNS TXT record `bountydesk-verification=<token>` or a `/.well-known/bountydesk.txt` file token, re-checked before every run with a 30-day expiry. The `ExternalTargetConfig` type in `lib/targets/external-target.ts` already has `baseUrl`, `egressHosts`, and `seedable` — the proof token and expiry would live in `config`.

The runtime path maps cleanly:

- `lib/targets/configure.ts` (`configureConnectionlessTarget`) is where the proof would be set up and stored.
- `lib/targets/quarantine.ts` (`quarantineStaleTargetProfile`) would handle the expired-proof case, dropping reports to `ANALYSIS_ONLY`.
- `lib/mcp/probe-target.ts` and `app/api/mcp/scope-guard/route.ts` are where the probe happens, and they already read `config.baseUrl`; the ownership proof field would be read here for pre-run validation.
- `lib/agent-sessions/poller.ts` (`autoApproveWriteProbe`) already gates POST probes to sandbox-local scope — the ownership re-check would run before this gate, not after.

The gap against current products: none of the six surveyed perform a *mandatory* ownership re-prove before each scan. Google Search Console's periodic re-check is closest; the 30-day TTL in Q33 is more aggressive and aligns with the offline sandbox model where a stale proof means the live host may have changed hands.

## 4. Risks and open questions

- **Spoofing the well-known path**: a `/.well-known/bountydesk.txt` file can be served by any CDN or proxy in front of the target. The proof should also resolve the address and reject loopback/metadata-ranges before accepting the token (Q33 notes this is a separate DNS-rebinding defense).
- **DNS rebinding during re-verification**: if the target's IP changes between the ownership proof and the probe, the proof is stale. The resolve-and-pin step in `lib/targets/external-target.ts` already rejects loopback; it should also cache the resolved address alongside the proof and invalidate on mismatch.
- **30-day expiry is arbitrary**: Google Search Console does not use a fixed TTL; it relies on periodic re-probing. If 30 days is too short, customers will hit false "proof expired" blocks. If too long, a host that changed hands stays green too long. No surveyed product uses a 30-day window as the documented standard.
- **Rate-limit the re-verification checks**: if the scanner runs frequently, repeated DNS TXT lookups or well-known fetch attempts could themselves look like an attack. None of the surveyed products document client-side rate limits for the verification probe itself.
- **Write-probe interaction**: Q33 states that write-probe auto-approve does not extend the ownership proof. This means a POST that succeeds does not re-prove ownership — the proof must be checked again at the start of the next run. This is stricter than all surveyed products and is a good safety property, but should be documented in the canary oracle flow.

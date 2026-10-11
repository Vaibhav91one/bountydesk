# How security products confirm a reported finding automatically

Research for issue #343: class-specific confirmation oracles for IDOR, path
traversal, and SSRF. Covers key products then maps onto BountyDesk code.

## 1. How current products handle each class

### IDOR and broken access control

Products confirm IDOR by replaying the same request under two identities and
diffing responses. The signal is extra data in the low-privileged response,
not a canary echo.

- **Burp Suite + Autorize** (Jython extension): captures requests from a
  high-priv user's proxied session, replays each twice (low-priv cookie, then
  unauthenticated), compares against user-supplied fingerprints (response
  string, regex, header, content-length)
  (https://github.com/Quitten/Autorize).

- **Burp AuthMatrix** (extension): tester defines a matrix of roles, users, and
  endpoints with a response regex. Replays every role/request pair
  (https://github.com/SecurityInnovation/AuthMatrix).

- **OWASP ZAP Access Control Testing add-on**: tester configures two+ users
  with different privilege levels. ZAP replays each authenticated request as
  each user and records success/failure. Ships in ZAP's default distribution
  (https://www.zaproxy.org/docs/desktop/addons/access-control-testing/).

- **Konvu**: a self-contained scan runner holding its own session store. Per
  the BountyDesk competitive audit (`docs/site/competitor-audit.html`, line 35),
  it reproduces IDOR and other classes. The audit does not detail how Konvu
  confirms IDOR beyond stating it does (unverified).

### Path traversal and file disclosure

Products confirm path traversal by injecting a `../` payload and checking the
response for known file-content markers. The signal is the expected file
content in the response body.

- **Burp Suite Pro**: sends traversal payloads (`../`, encoded, null bytes).
  For `/etc/passwd` matches `root:x:`; for `/etc/hosts` matches `127.0.0.1`.
  Confirmation is the file content, not just a 200
  (https://portswigger.net/burp/documentation/scanner).

- **Nuclei**: YAML template with a `../` payload and a body matcher (regex or
  literal string). For `/etc/passwd` matches `root:.*`
  (https://docs.projectdiscovery.io/templates/).

- **Invicti (Proof-based Scanning)**: reads a known file through the traversal
  and checks the response contains predictable content. Proofs-node docs list
  "Local File Inclusion" as a supported proof type. Relies on deterministic file
  content, not a canary (https://docs.invicti.com/ie-is/proofs-node).

### Server-side request forgery (out-of-band)

All OOB products generate a unique per-payload URL, inject it into the SSRF
vector, and poll a listener for a callback. The signal is the interaction
record keyed to the run's unique URL.

- **Burp Collaborator**: built-in HTTP/DNS/SMTP server. Scanner generates unique
  per-payload URLs; the target's callback arrives at Burp's Collaborator
  server. Interactions polled every 60 seconds
  (https://portswigger.net/burp/documentation/desktop/tools/collaborator/getting-started).

- **ProjectDiscovery Interactsh**: self-hosted or cloud-hosted Go service
  accepting DNS, HTTP(S), SMTP(S), and LDAP callbacks. Client generates a
  unique subdomain, injects it, polls the API for interactions keyed by the
  payload's correlation ID. AES-encrypted payloads, zero-logging
  (https://raw.githubusercontent.com/projectdiscovery/interactsh/master/README.md).

- **ZAP**: built-in OOB alpha add-on or separate interactsh add-on. Same model:
  unique URL, inject, poll
  (https://www.zaproxy.org/docs/desktop/addons/).

### How DAST vendors describe verification evidence

- **Invicti**: calls its approach "Proof-based Scanning", dynamically exploiting
  vulnerabilities in a safe, read-only way. Evidence types include SQL injection
  proof (injected value from a UNION), blind SQLi, LFI proof (file content),
  and RCE proof
  (https://docs.invicti.com/ie-is/proofs-node).

- **Snyk API & Web**: each finding includes "vulnerability evidence" as the
  HTTP request/response pair demonstrating exploitability
  (https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-api-web.md).

- **Snyk Code (SAST)**: verification is a taint-analysis trace from source to
  sink with a confidence score, no runtime callback or canary
  (https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code.md).

## 2. Comparison table

| Product | IDOR/access control | Path traversal | SSRF (OOB) | Evidence model |
|---|---|---|---|---|
| Burp Pro + Autorize/AuthMatrix | Replay as low-priv + unauth user, diff vs fingerprints | Known-content marker (`root:x:` in `/etc/passwd`) | Collaborator; unique URL per payload; poll for interactions | Request/response pair + diff; fingerprints user-supplied |
| OWASP ZAP | Two+ users, replay per user, compare body/status/length | Path traversal payloads with regex/string matchers | Built-in OOB listener or Interactsh add-on | Matcher result; interaction record for OOB |
| Konvu | Not detailed in audit source (unverified) | Known-content markers | Self-hosted/cloud callback listener (unverified) | Unknown (unverified) |
| Invicti | Response diff across session states | File-content proof (LFI in proofs node) | Unique OOB URL injected, interaction recorded | Proofs node: structured proof with request/response |
| Nuclei | Template request with two auth contexts + matchers | HTTP template with `../` payload + body matcher | Interactsh: unique URL injected, polled via API | Matcher fired; interaction record for OOB |
| Snyk API & Web | Replay as different auth contexts; evidence includes endpoints | File-content markers in response body | OOB capture via cloud/self-hosted listener | Finding evidence: request/response pair, endpoints |
| Snyk Code (SAST) | N/A (static) | N/A (static) | N/A (static) | Taint-analysis trace with confidence |

## 3. How it fits BountyDesk's existing code

BountyDesk already has the scaffolding. The canary oracle pipeline is in
`lib/sandbox/reproduce.ts`, the decision rule in `lib/reproduction/decide.ts`,
the recipe type in `lib/reproduction/types.ts`, and the Juice Shop recipes in
`lib/targets/recipes.ts`. The onboarding-target recipes in
`lib/targets/recipes.additional.ts` already describe the verification patterns
this research confirms.

- **IDOR / broken auth:** the `juice-shop-login-bypass` recipe in `recipes.ts`
  (lines 211-240) is a token-mint pattern, not a two-identity differential: the
  exploit posts a SQLi auth-bypass payload, receives a session token, and the
  `exploitFollowUp` mechanism (`reproduction/types.ts` lines 116-126) uses that
  token to issue a follow-up `GET /api/Users` request and check for the canary
  in the second response. Autorize and ZAP replay the same request under two
  identities. A genuine two-identity IDOR recipe needs a second fixture
  principal, but the `fixture` field (`types.ts` line 82) holds only one
  `ReproductionRequest`. Routing happens through `authorizeReproductionTarget`
  in `lib/targets/authorize-reproduction.ts`, which looks up the recipe by
  `recipeId` and checks `recipeOracleReady` (line 179) before proceeding.

- **Path traversal / file disclosure:** the pattern is a known-content marker
  check, not a canary echo. The `oracleCheck` signature in
  `reproduction/types.ts` (lines 103-106) already supports this: it receives the
  full response and the canary string. For path traversal the check would be
  `response.body.includes(sentinel)`. The `preBlocks` function in
  `recipes.additional.ts` (lines 33-43) already does response-substring
  matching for `<pre>` blocks in DVWA.

- **SSRF (out-of-band):** the gap is named in `docs/additional-targets.md`
  (lines 90-95) and the issue. The in-band HTTP oracle in `reproduce.ts`
  cannot see an OOB callback. The issue's approach is an in-mesh HTTP
  listener peer reusing the mesh in `scripts/spike-linked-sandboxes.ts` and
  `lib/sandbox/provision-mesh.test.ts`, secured by `verifyNoEgress` in
  `provision.ts`. The `runBrowserProbe` function in `browser-probe.ts`
  (lines 246-344) is the closest pattern: provisions an isolated offline
  sandbox link-joined to the target. An SSRF listener oracle would provision a
  second sandbox as a peer, bind the canary URL into the exploit payload, and
  poll the listener's log. The `exploitFollowUp` mechanism (`types.ts`
  lines 116-126) could carry the listener poll as a follow-up step, but the
  listener itself is new infrastructure. The issue names `autoApproveWriteProbe`
  in `lib/agent-sessions/poller.ts` as the precedent for in-sandbox auto-approval
  of probes that only reach the reproduction sandbox.

- **Negative control:** `decideOutcome` in `decide.ts` already enforces the
  clean-negative-control rule across all recipe types. If the negative control
  finds the canary, sentinel, or OOB interaction, the run is `ANALYSIS_ONLY`,
  not `NOT_REPRODUCED`. `decideOutcome` (`decide.ts` lines 21-25) takes a
  `ReproductionRun` with five boolean fields (lines 11-17); for SSRF "canary
  found" carries the listener result, for path traversal the sentinel match.

## 4. Risks and open questions

- **Canary secrecy for IDOR.** The canary is a per-run secret the PoC cannot
  guess, but IDOR confirmation is a response diff, not a canary echo. The risk
  is a fixture-seeded sentinel being predictable. The canary oracle's
  mitigations (unpredictable per-run value, trusted fixture seeding, judged
  outside the sandbox) suggest the same approach: the fixture generates a
  random per-run ID for user B's resource, and the oracle (not the PoC)
  checks that user A can read it. **Not verified** live.

- **OOB false positives for SSRF.** Collaborator and Interactsh can receive
  callbacks from scanners, CDNs, or health checks. The issue's preference for an
  in-mesh listener limits this: the only path to the listener is through the
  target sandbox. **Not verified** in the mesh environment; the mesh-specific
  proof is not yet built.

- **Path traversal sentinel placement.** For path traversal the confirmation
  is a sentinel file on disk the app should never serve. Planting it requires a
  write-capable fixture endpoint or a sandbox filesystem write. BountyDesk's
  oracle boundary rule (`reproduction/types.ts` lines 7-12) holds that
  sandbox-exec stdout is tainted, so the sentinel must be planted by the trusted
  fixture, not the PoC. Whether the fixture can write an arbitrary file to an
  arbitrary path **has not been determined** for the demo target.

- **Two-user fixture support.** `ReproductionRecipe.fixture` (`reproduction/types.ts`
  line 82) is a single `ReproductionRequest`. Extending to two principals
  requires a type change touching `decide.ts`, `reproduce.ts`, and tests in
  `reproduce.test.ts` and `recipes.test.ts`.

- **SSRF listener lifecycle.** `provision.ts` `teardownSandbox` and TTL-based
  cleanup (`reproduce.ts` lines 481-485) are existing lifecycle controls.
  The mesh provisioning path (`provision-mesh.test.ts`) has not yet been
  exercised by the oracle, and the listener's interaction log must be read by
  the trusted controller, not the sandbox's exec API.

- **Unverified claims.** Invicti's Proof-based Scanning documentation was fetched
  and read; the exact mechanism for auth-bypass proof was not confirmed in a
  live scan. ZAP's access-control add-on API was read but not exercised.
  Konvu's own product pages were not reachable (domain redirected); the summary
  is from the BountyDesk competitive audit only.
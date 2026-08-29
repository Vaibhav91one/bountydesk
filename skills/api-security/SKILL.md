---
name: bountydesk-api-security
description: OpenAPI-driven API assessment for the BountyDesk agent. Use when the target exposes openapi.json/swagger or is an API-first service (REST/JSON). Covers OWASP API Top 10 probing: BOLA, broken auth, mass assignment, excessive data exposure.
---

# BountyDesk API security playbook

Use when recon finds `openapi.json`, `swagger.json`, or JSON-over-HTTP
API surface. APIs are judged by the OWASP API Top 10, not web checklists.

## Bootstrap

```bash
curl -s http://<target>/openapi.json -o artifacts/openapi.json
python3 - <<'PY'
import json
spec = json.load(open('artifacts/openapi.json'))
for path, methods in spec.get('paths', {}).items():
    for m in methods:
        if m in ('get','post','put','patch','delete'):
            print(m.upper(), path, '| params:',
                  [p.get('name') for p in methods[m].get('parameters', [])])
PY
```

## Priority probes (OWASP API Top 10 order)

1. **BOLA/IDOR**: for every path with an object identifier (`/books/{title}`,
   `/users/{id}`): request WITHOUT auth, then with a second identity's id.
   Success means the object came back, which is a finding.
2. **Broken authentication**: enumerate auth requirements per endpoint from
   the spec's `security` blocks vs actual behavior (401 vs 200 anonymous).
3. **Mass assignment**: POST/PATCH with extra fields from GET responses
   (`{"role":"admin", ...}`). Diff response for privilege change.
4. **Excessive data exposure**: compare list-endpoint fields vs detail fields;
   flag internal fields (hashes, keys, internal flags) in list responses.
5. **Improper inventory**: deprecated/undocumented paths still responding;
   debug routes from HTML comments.

## JWT-specific checks (when JWTs observed)

- Decode header/payload: `alg` value; if HS256 with a weak/leaked secret or
  `none` accepted, that's a critical forgery.
- Key confusion: if server publishes/uses RS256 and accepts tokens signed as
  HS256 using the public key, test it explicitly.
- Claim tampering: modify `role`/`sub` claims, keep signature, observe 401 vs
  200.
- Record exact token strings used into evidence files, never into chat.

## Rules

- Every probe needs `scope_check` and grant discipline identical to recon
  Phase 2/3.
- Mass-assignment attempts on real user objects must use SELF-owned objects,
  never mutate other tenants' data beyond read confirmation.
- Findings pass the `bountydesk-validation` 5-check gate before reporting.

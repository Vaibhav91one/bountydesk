# Additional reproduction targets

BountyDesk has one target that is fully built and verified, the pinned juice-shop at v17.3.0.
This document covers four more that are now scaffolded in code: a target profile in the
registry and a reproduction recipe each, wired into the same lookup juice-shop uses. None of
the four is live. What exists is the config and the recipe an operator needs to build and
register the image, which is the state juice-shop was in before its snapshot was built.

The registry entries live in `lib/targets/registry.ts`, the recipes in
`lib/targets/recipes.additional.ts`, and the oracle tests in `lib/targets/recipes.test.ts`.
Every profile leaves `imageDigest` and `snapshotId` unset and carries `PENDING_OPERATOR_BUILD`
as its build marker, because those three values come from the build step and nothing should
reproduce against a target that has not been built.

## The four targets

| Profile | Repo | Upstream image the fork is based on | Port | Recipe | Vulnerability class |
| --- | --- | --- | --- | --- | --- |
| `dvwa` | `Vaibhav91one/DVWA` | `docker.io/vulnerables/web-dvwa` | 80 | `dvwa-command-injection` | OS command injection |
| `webgoat` | `Vaibhav91one/WebGoat` | `docker.io/webgoat/webgoat` | 8080 | `webgoat-sqli-lesson` | SQL injection |
| `dsvw` | `Vaibhav91one/DSVW` | built from the repo's single-file `dsvw.py` | 65412 | `dsvw-sqli` | SQL injection |
| `log4shell-cve-lab` | `Vaibhav91one/log4shell-cve-lab` | built from the repo's own Dockerfile | 8080 | `log4shell-jndi` | Log4Shell (CVE-2021-44228) |

The `imageName` for each is `ghcr.io/vaibhav91one/<profile>`, matching how juice-shop is built
and pushed. The upstream image in the table is the source the fork's Dockerfile is expected to
build from, not the value written to the profile. DVWA and WebGoat have a well known public
image; DSVW is a single Python file with no canonical image, and the Log4Shell lab ships its own
Dockerfile, so both of those are built from source.

## These four cannot produce a verdict, by construction

Documentation alone would not stop a future operator who builds a snapshot and seeds one of these
profiles from getting a silently wrong verdict, so the block is structural rather than written.
Each of the four recipes carries `oracleReady: false` (see the field's doc in
`lib/reproduction/types.ts`), and `authorizeReproductionTarget` treats a not-ready recipe exactly
as it treats a missing one: `NO_APPROVED_ORACLE`. Since authorization is the single gate every
reproduction run passes through, a run against any of these four resolves `ANALYSIS_ONLY` today no
matter what the app returns. A false `REPRODUCED` is impossible until someone deliberately removes
the flag, and removing it is the same act as closing the gap below. juice-shop's recipes carry no
flag, so they stay ready and unchanged.

## Why each recipe is not ready yet, beyond the missing image

juice-shop is a JSON API, and the reproduction orchestrator is built for one: it substitutes the
run's fresh canary only inside a POST body, sends that body as `application/json`, and hands the
oracle only in-band 2xx responses. Three of these four apps do not match that shape, so each
recipe records the gap it waits on. The recipe request and the oracle are already correct; the
gap is orchestrator work.

- `dvwa` and `webgoat` read form-encoded parameters and gate the vulnerable page behind a login.
  The canary rides in the POST body, so it is substituted, but the built image has to accept the
  body and present the page in an initialised, authenticated state. For DVWA that means the
  database created and security set to low; for WebGoat it means the SQL injection lesson
  reachable.
- `dsvw` takes its injection through a GET query string. The orchestrator does not substitute the
  canary into a request path today, only into a body, so this recipe needs path substitution (or
  a POST variant of the endpoint on the built image) before it can run.
- `log4shell-cve-lab` proves itself out of band. The evidence is the vulnerable app reaching a
  collector the run controls, keyed by the canary, not anything in the HTTP response. The in-band
  oracle here checks the response body for the canary as a weak proxy. A real verdict needs an
  out-of-band oracle: a per-run DNS or LDAP canary token and a collector the orchestrator can
  query. The canary also belongs in the injected header, and header substitution is not wired
  either.

One assumption is worth calling out. The WebGoat recipe targets `assignment5a`, the WebGoat 8.x
string-injection assignment, and its UNION payload assumes a column count for `user_data`. Both
the lesson path and the column count are version specific, so confirm them against the image you
actually build and adjust the payload if the schema differs. This is marked in the recipe with a
`ponytail:` comment.

## Operator steps that remain, per target

These mirror the juice-shop path and are not done for any of the four.

1. Fork the upstream app into `Vaibhav91one` (already done for all four) and pin it at a commit.
2. Build a `linux/amd64` image from the fork, baking the source commit in as the build marker the
   way `.github/workflows/build-daytona-target.yml` does for juice-shop, and push it to
   `ghcr.io/vaibhav91one/<profile>`. Record the resolved digest.
3. Create a Daytona snapshot from the digest-pinned image and record the snapshot id.
4. For DVWA and WebGoat, make sure the image boots into a state where the vulnerable page
   answers without a manual setup click: DVWA's database created and security low, WebGoat's
   lesson reachable. Add a `startCommand` to the profile if the snapshot does not auto-start the
   app, as juice-shop needed one.
5. Seed the profile and bind the connected repository:

   ```
   BOUNTYDESK_TARGET_DVWA_IMAGE_DIGEST=sha256:... \
   BOUNTYDESK_TARGET_DVWA_SNAPSHOT_ID=... \
   BOUNTYDESK_TARGET_DVWA_BUILD_MARKER=<the-pinned-fork-commit> \
   npm run seed:target -- <github-repository-id> dvwa
   ```

   The seed script is generic: it reads the pin from `BOUNTYDESK_TARGET_<PREFIX>_*` for whatever
   profile name it is given, so no script change was needed to add these. Passing
   `BOUNTYDESK_TARGET_<PREFIX>_BUILD_MARKER` overrides the `PENDING_OPERATOR_BUILD` placeholder
   with the real commit, so the constant in the registry does not have to be edited by hand.
6. Close the orchestrator gap the recipe names: form-encoded bodies for DVWA and WebGoat, path or
   header canary substitution for DSVW and Log4Shell, and an out-of-band oracle for Log4Shell.
   Then, and only then, mark the recipe ready by removing its `oracleReady: false`. Until that
   flag is gone the run stays `ANALYSIS_ONLY`, which is the correct outcome for a target that
   cannot yet be proven. Flipping the flag without closing the gap is the one thing that would
   reintroduce the false-verdict risk, so it is deliberately a separate, visible edit.

Only after all of this can a report against one of these repositories produce a reproduced or
not-reproduced verdict. Until then the capability boundary refuses it, exactly as it should.

# Additional reproduction targets

BountyDesk has two targets with a built, registered image: juice-shop at v17.3.0, and now DVWA
at v1.9 (PR #371). This document covers four more that are scaffolded in code: a target profile
in the registry and a reproduction recipe each, wired into the same lookup juice-shop uses.
WebGoat, dsvw and log4shell-cve-lab are not live. What exists for those three is the config and
the recipe an operator needs to build and register the image, which is the state juice-shop and
DVWA were in before their snapshots were built.

DVWA's image being built does not by itself make the target ready for a verdict: its recipe
still carries `oracleReady: false` (see the next section), because the orchestrator gap below
(form-encoded bodies, an authenticated session) is still open. Building and registering the
image was the harder, infrastructure half; closing the orchestrator gap is separate work.

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
and pushed. The upstream image in the table is the source each fork's Dockerfile is based on or
otherwise expected to build from, not necessarily the value written to the profile: DVWA's own
public image (`docker.io/vulnerables/web-dvwa`) is a two-container build (app plus a separate
MariaDB container via compose), which a single-container Daytona sandbox cannot boot as-is, so
the registered image instead extends the fork's own Dockerfile with MariaDB bundled into the same
image (see "Bundling a datastore into one image" below). WebGoat's public image is not used for
the same structural reason once that target is built. DSVW is a single Python file with no
canonical image, and the Log4Shell lab ships its own Dockerfile, so both of those are built from
source.

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
  body and present the page in an initialised, authenticated state.
  - For DVWA, half of this is now done: the registered image creates its database and seeds the
    default `admin`/`password` account automatically on boot (see the pattern below). What is
    still manual, and still blocks `oracleReady`, is the authenticated session itself and the
    security level: DVWA defaults to `impossible`, which fully sanitises the command-injection
    page, so a run needs a login (`POST /login.php` with a CSRF `user_token` read off a prior
    GET) and a security-level change (`POST /security.php`, same CSRF pattern) before the page is
    exploitable at all. This is orchestrator work (carrying a session across the run, or baking
    the security-level change into the image's own start script, the way the database creation
    already is) and is not done.
  - For WebGoat, the SQL injection lesson is not reachable because it does not exist in this
    fork at all. The pinned `7.1` tag's lesson content, including the lesson the recipe targets,
    lives in a separate `WebGoat-Lessons` repository the project's own developer bootstrap script
    clones alongside this one and builds into a second artifact before the container module can
    serve it. Confirmed by reading `webgoat_developer_bootstrap.sh` and by grep: no lesson class
    for SQL injection exists anywhere in the `Vaibhav91one/WebGoat` fork outside a test file that
    references it by name. The base `webgoat-container` module itself builds and runs fine as a
    WAR (`mvn -pl webgoat-container tomcat7:run-war`, matching the registry's port 8080 and
    `/WebGoat` context path); it is specifically the lesson content that is missing. Closing this
    needs forking and pinning a `WebGoat-Lessons` commit compatible with the `7.1`-era lesson API
    (not a later restructured one), wiring it into the build as a second source, and verifying
    `assignment5a` actually resolves once both are built together.
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

## Bundling a datastore into one image

A target whose own build packages the app and its database as separate containers (DVWA's
`compose.yml`, and most apps of this shape) needs restructuring before a single-container
Daytona sandbox can boot it. The pattern that worked for DVWA, reusable for the next target in
this situation:

1. Extend the app's own Dockerfile (do not start from scratch) with the datastore's server
   package installed alongside the app's own dependencies, in the same image.
2. Write a start script as the image's `CMD`, not a second `COPY`-in entrypoint file from the
   fork: initialise the datastore's data directory if it is empty (so a restart with an existing
   volume does not re-run init), start it in the background, poll until it answers, then run
   whatever one-time schema and seed step the app itself provides.
3. Prefer the app's own setup flow over a hand-written SQL file. DVWA's schema and seed data are
   built by PHP code (`dvwa/includes/DBMS/MySQL.php`), not shipped as a static `.sql`, triggered
   by the same `POST /setup.php` a person clicks "Create / Reset Database" for. If that flow sits
   behind the same CSRF token pattern the rest of the app uses, the start script has to fetch the
   token off a prior GET first: a blind POST with no token does not error, it silently no-ops,
   which looked like success until the users table turned out empty. Confirm the seed actually
   landed (a row count, not just an HTTP status) before trusting it.
4. Start the app itself in the foreground last, after the datastore and the schema step both
   succeed, so the container's own lifecycle matches the app's readiness.
5. A tool invoked via `shell_exec`/`exec()` by the app (DVWA's command injection pings a host)
   may need a Linux capability the app's own service user does not have by default. `ping`'s raw
   socket needs `CAP_NET_RAW`; `setcap cap_net_raw+ep` on the binary at build time (needs
   `libcap2-bin`) grants it without making the whole binary setuid-root. Silent, empty output
   from an otherwise-correct injection is the symptom: run the exact command as the app's own
   service user (not root) during local testing to catch this before it reaches a real sandbox.

### Apple's `container` tool (local builds, macOS 15+)

Building and testing locally before any cloud spend, with Apple's native `container build` /
`container run`, surfaced two real tool limitations worth knowing before the next build:

- **Always pass an absolute build context path**, never `.`. A relative context silently breaks
  the tool's ability to resolve any `COPY`/`ADD` source, failing with a "not found" error that
  looks like a missing file rather than a context-resolution problem.
- **A directory source in `COPY`/`ADD` does not bring its contents along.** Confirmed with a
  minimal reproduction (a single subdirectory holding one file): the destination directory is
  created, but empty, no error raised. Only an individually named file copies correctly, at any
  depth. The workaround: tar the source directory on the host, `COPY` that one tarball file in
  (a file copy, which works), then `RUN tar -xzf ... && rm` to extract it inside the build,
  rather than copying the source tree directly.
- **`container run` cannot execute a cross-built image.** `container build --platform
  linux/amd64` on an Apple Silicon host produces a real amd64 image (Daytona's snapshot path
  expects amd64), but the local runtime only executes images matching the host's own
  architecture. The amd64 image can be build-verified and pushed, but its first real boot test
  has to happen somewhere that can run amd64: a real Daytona sandbox created from the registered
  snapshot is an immediate, authoritative substitute for a local boot test, and is worth doing
  once per new target before calling the build "verified."

## Operator steps that remain, per target

These mirror the juice-shop path. Steps 1 through 3 and 5 are done for DVWA (PR #371); step 4 is
only half done for DVWA (database creation, not the security level), and none of the five is
done yet for the other three.

1. Fork the upstream app into `Vaibhav91one` (already done for all four) and pin it at a commit.
2. Build a `linux/amd64` image from the fork, baking the source commit in as the build marker the
   way `.github/workflows/build-daytona-target.yml` does for juice-shop, and push it to
   `ghcr.io/vaibhav91one/<profile>`. Record the resolved digest.
3. Create a Daytona snapshot from the digest-pinned image and record the snapshot id.
4. Make sure the image boots into a state where the vulnerable page answers without a manual
   setup click. The image itself does not need a `startCommand` added to the profile the way
   juice-shop's did if its own `CMD` already starts everything (DVWA's does, see the pattern
   above); add one only if the snapshot does not auto-start the app on its own.
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

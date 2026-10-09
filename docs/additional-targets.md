# Additional reproduction targets

BountyDesk has three targets with a built, registered image: juice-shop at v17.3.0, DVWA at v1.9
(PR #371) and WebGoat at v2025.3. This document covers four that are scaffolded in code: a target
profile in the registry and a reproduction recipe each, wired into the same lookup juice-shop
uses. dsvw and log4shell-cve-lab are not live. What exists for those two is the config and the
recipe an operator needs to build and register the image, which is the state juice-shop, DVWA and
WebGoat were in before their snapshots were built.

DVWA's and WebGoat's images being built do not by themselves make the target ready for a verdict: its recipe
still carries `oracleReady: false` (see the next section; dsvw-sqli is the one exception),
because the orchestrator gap below (form-encoded bodies, an authenticated session) is still open. Building and registering the
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

## Three of these four cannot produce a verdict, by construction

Documentation alone would not stop a future operator who builds a snapshot and seeds one of these
profiles from getting a silently wrong verdict, so the block is structural rather than written.
The WebGoat, DVWA and Log4Shell recipes carry `oracleReady: false` (see the field's doc in
`lib/reproduction/types.ts`), and `authorizeReproductionTarget` treats a not-ready recipe exactly
as it treats a missing one: `NO_APPROVED_ORACLE`. Since authorization is the single gate every
reproduction run passes through, a run against any of these three resolves `ANALYSIS_ONLY` today no
matter what the app returns. A false `REPRODUCED` is impossible until someone deliberately removes
the flag, and removing it is the same act as closing the gap below. juice-shop's recipes carry no
flag, so they stay ready and unchanged.

`dsvw-sqli` is the exception: it is `oracleReady: true`. The flag is read only by
`authorizeReproductionTarget`, whose only caller is `createReproducer` in
`lib/sandbox/reproduce.ts`, and no live path imports that (only tests do). The live verdict path is
the agent's own `probe_target` investigation, which does not run the canary oracle, so the oracle's
gap cannot reach a verdict today. The gap itself is open: canary substitution happens only in POST
bodies, so a GET exploit such as DSVW's would send a literal `{{canary}}`, and with a clean negative
control `decideOutcome` would return a false `NOT_REPRODUCED`. That stays open until #343. Before
`reproduce` is wired into any live path, set `oracleReady: false` on `dsvw-sqli`. Any `REPRODUCED`
the agent draws is still human-approved.

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
  - For WebGoat, the image is built and the lesson is reachable (see "WebGoat version choice"
    below). What still blocks `oracleReady` is the registration and login: the lesson endpoint
    was only exercised with a session cookie from `POST /WebGoat/register.mvc` and
    `POST /WebGoat/login`, and carrying that session is the same orchestrator gap as DVWA's.
- `dsvw` takes its injection through a GET query string. The orchestrator does not substitute the
  canary into a request path today, only into a body, so this recipe needs path substitution (or
  a POST variant of the endpoint on the built image) before it can run.
- `log4shell-cve-lab` proves itself out of band. The evidence is the vulnerable app reaching a
  collector the run controls, keyed by the canary, not anything in the HTTP response. The in-band
  oracle here checks the response body for the canary as a weak proxy. A real verdict needs an
  out-of-band oracle: a per-run DNS or LDAP canary token and a collector the orchestrator can
  query. The canary also belongs in the injected header, and header substitution is not wired
  either.

## WebGoat version choice

The first plan pinned the `7.1` tag, to match the older lesson path. That tag has no SqlInjection
lesson: 7.x kept lessons in a separate `WebGoat-Lessons` repository built into a second artifact,
so it needed a second fork and a compatible lessons commit. The `v2025.3` tag (fork commit
`c3ed45a733377bc7313b93f57ff518254d81380f`) is a single Spring Boot jar with every lesson
bundled, an embedded Tomcat and an embedded HSQLDB, so there is no datastore to bundle and no
second source. It still serves `POST /WebGoat/SqlInjection/assignment5a` on port 8080 with the
`/WebGoat` context path, so the registry's path and port did not change. That is simpler and
satisfies the issue, so the 7.1 route was dropped.

The jar is built from the pinned source (not the upstream release asset) with `mvn package` on
JDK 23: the pom sets `release 23`, and Lombok 1.18.36 does not compile under a JDK 24 host, so the
build ran inside `maven:3.9-eclipse-temurin-23`. The image is `eclipse-temurin:23-jdk-noble` plus
the jar, the fork's own entrypoint flags, and the build marker at `/etc/bountydesk-build-marker`.
It is a plain `COPY` of the one jar, and the jar is architecture independent, so cross-building
the image for `linux/amd64` costs nothing.

The image is pushed as `ghcr.io/vaibhav91one/webgoat@sha256:0cdce0e66e20a2d010dad765313ae4dd8066308487933c7f77af6245de7fab13`
and registered as the Daytona snapshot `bountydesk-webgoat-marker`
(`62258ce4-552f-4a8a-8a1f-6071ab7d7bef`, 2 CPU, 4 GB, 10 GB disk). In a real Daytona sandbox
created from it, the build marker matched, the JVM started from the image's own `ENTRYPOINT` with
no start command, and `/WebGoat/login` answered `HTTP/1.1 200` after about 40 seconds. The registry
entry sets no `warmupSeconds`, so set one (about 60) if the readiness poll turns out too short.
The image has no `curl`, so check readiness with `wget` or a bash `/dev/tcp` probe. An
authenticated lesson request was not completed inside the sandbox (the `wget` cookie handling
returned the login page), so the exploit result below comes from the local boot only.

`container image push` hung for over 15 minutes twice with no layer completing, though the uplink
was fine. The image was instead saved with `container image save` and uploaded blob by blob with
the registry HTTP API, then the single-platform manifest was put under the tag.

Checked against a local boot of the same image (arm64, because `container run` cannot run amd64):
`/WebGoat/login` answers 200 with no session, and after registering and logging in a user the
lesson endpoint runs the injection. The recipe's old payload failed with `incompatible data
types in combination`, because `user_data` has seven columns (`userid` and `login_count` are
integers) and HSQLDB rejects a string literal in those positions. The recipe now selects
`1,'{{canary}}','x','x','x','x',1`, which returned the canary as a result row. The lesson also
appends `Your query was: <sql>` to every `output`, which echoes the canary even when the injection
errored, so the oracle only reads the text before that suffix.

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

- **Keep the build context under `$HOME`, not `/private/tmp`.** A context in `/private/tmp` failed
  with `"/webgoat.jar": not found` for a file that was on disk with the right mode; the same
  directory copied to `$HOME` built fine.
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
only half done for DVWA (database creation, not the security level). For WebGoat, steps 1 through
4 are done (the image boots on its own `ENTRYPOINT` and answers `/WebGoat/login`); step 5 binds a
repository and is left to the operator. None of them is done for the other two.

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
   Then, and only then, mark the recipe ready by removing its `oracleReady: false` (dsvw-sqli is already ready, see above). Until that
   flag is gone the run stays `ANALYSIS_ONLY`, which is the correct outcome for a target that
   cannot yet be proven. Flipping the flag without closing the gap is the one thing that would
   reintroduce the false-verdict risk, so it is deliberately a separate, visible edit.

Only after all of this can a report against one of these repositories produce a reproduced or
not-reproduced verdict. Until then the capability boundary refuses it, exactly as it should.

---
name: bountydesk-demo-targets
description: Boots DVWA or WebGoat, deliberately-vulnerable teaching applications, inside the agent's own sandbox for a demo or practice investigation. Use only when the mission explicitly asks for a DVWA or WebGoat demo, never for an authorized bug-bounty report, which resolves its target through scope_check instead.
---

# BountyDesk demo targets

This skill is for demo and practice investigation only, against DVWA and
WebGoat, two well-known teaching applications built to be broken. It is never
for an authorized bug-bounty report. A real report resolves its target
through `scope_check` against a server-held `TargetProfile` (see
`bountydesk-recon`); nothing in this skill applies there.

## Boot it yourself, in your own sandbox

Nothing deploys DVWA or WebGoat ahead of time. When a mission asks you to
investigate one of them, run the matching boot sequence below yourself, using
your sandbox's own execute capability. Each sequence ends by polling the
target's own login page and writing a status file, so you know when it's safe
to start probing rather than guessing at a fixed sleep. Wait for that file
before sending a single request to the target.

### DVWA (PHP + MariaDB, port 8081)

```bash
STATUS=/tmp/dvwa_status.txt
LOG=/tmp/dvwa.log
PORT=8081
DIR=/tmp/dvwa

fail() { echo "FAILED $1" > "$STATUS"; tail -30 "$LOG" >> "$STATUS" 2>/dev/null; exit 1; }
log() { echo "[dvwa] $*" >> "$LOG"; echo "[dvwa] $*" > "$STATUS"; }

echo "[dvwa] $(date -Is) start" > "$STATUS"
: > "$LOG"

log "apt install php + mariadb"
export DEBIAN_FRONTEND=noninteractive
(apt-get update -qq \
  && apt-get install -y -qq php-cli php-mysqli php-gd mariadb-server mariadb-client unzip git) \
  >>"$LOG" 2>&1 || fail "apt package install failed"

# 2. acquire DVWA (not pinned, see the caveat below)
rm -rf "$DIR"
git clone --depth 1 https://github.com/digininja/DVWA "$DIR" >>"$LOG" 2>&1 || fail "clone failed"

# 3. database up
(mysqld_safe --skip-grant-tables=0 >>"$LOG" 2>&1 &) || true
for i in $(seq 1 24); do
  mysqladmin ping >/dev/null 2>&1 && break
  sleep 5
done
mysqladmin ping >/dev/null 2>&1 || fail "mariadb never became ready"
mysql -e "CREATE DATABASE IF NOT EXISTS dvwa; CREATE USER IF NOT EXISTS 'dvwa'@'127.0.0.1' IDENTIFIED BY 'p@ssw0rd'; GRANT ALL ON dvwa.* TO 'dvwa'@'127.0.0.1'; FLUSH PRIVILEGES;" >>"$LOG" 2>&1 || fail "db bootstrap failed"

# 4. config (DVWA's shipped default already reads DB_USER/DB_PASSWORD env vars
# as dvwa/p@ssw0rd, so this just copies the template; no edit is required)
cp "$DIR/config/config.inc.php.dist" "$DIR/config/config.inc.php"

# 5. serve
cd "$DIR"
nohup php -S 127.0.0.1:$PORT </dev/null >>"$LOG" 2>&1 &
echo $! > /tmp/dvwa.pid
disown 2>/dev/null || true

# 6. readiness
for i in $(seq 1 24); do
  sleep 5
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "http://127.0.0.1:$PORT/login.php" || true)
  if [ "$CODE" = "200" ]; then
    # setup.php only creates the tables on a POST carrying create_db plus a
    # CSRF token that has to match the session, so a plain GET (which just
    # renders the form) leaves the database empty. Scrape the token DVWA's
    # own dvwaFormToken() embeds in that GET response, then POST it back.
    JAR=/tmp/dvwa_cookies.txt
    SETUP_PAGE=$(curl -s -c "$JAR" -m 8 "http://127.0.0.1:$PORT/setup.php")
    TOKEN=$(echo "$SETUP_PAGE" | grep -oE "name='user_token' value='[^']*'" | sed -E "s/.*value='([^']*)'/\1/")
    curl -s -b "$JAR" -c "$JAR" -m 8 -d "create_db=1" -d "user_token=$TOKEN" \
      "http://127.0.0.1:$PORT/setup.php" >/dev/null
    echo "READY http://localhost:$PORT (login.php 200; admin/admin after setup)" > "$STATUS"
    exit 0
  fi
done
fail "login page never returned 200"
```

### WebGoat (Java, port 8080)

```bash
STATUS=/tmp/webgoat_status.txt
LOG=/tmp/webgoat.log
PORT=8080
DIR=/tmp/webgoat-runtime

fail() { echo "FAILED $1" > "$STATUS"; tail -30 "$LOG" >> "$STATUS" 2>/dev/null; exit 1; }
log() { echo "[webgoat] $*" >> "$LOG"; echo "[webgoat] $*" > "$STATUS"; }

echo "[webgoat] $(date -Is) start" > "$STATUS"
: > "$LOG"

# 1. Java runtime, via the GitHub API rather than scraping the releases page:
# GitHub now lazy-loads a release's asset list with JavaScript, so a plain
# GET of /releases/latest no longer contains the download links in its HTML.
# The API's JSON always has them.
if ! command -v java >/dev/null 2>&1; then
  log "fetching Temurin JRE 21"
  mkdir -p /opt/jre
  ASSET_URL=$(curl -sSL https://api.github.com/repos/adoptium/temurin21-binaries/releases/latest \
    | grep -oE '"browser_download_url": *"[^"]*OpenJDK21U-jre_x64_linux_hotspot[^"]*\.(zip|tar\.gz)"' \
    | head -1 | sed -E 's/.*"(https:[^"]*)"/\1/')
  [ -n "$ASSET_URL" ] || fail "no Temurin JRE asset found"
  BF=$(basename "$ASSET_URL")
  curl -sSL --retry 3 -o "/tmp/$BF" "$ASSET_URL" >>"$LOG" 2>&1 || fail "JRE download failed"
  case "$BF" in
    # unzip keeps the archive's top-level jdk-*/ folder, so JAVA_HOME is a
    # find away; --strip-components=1 on the tarball removes that folder
    # during extraction, so JAVA_HOME is /opt/jre itself, not a subdirectory.
    *.zip)
      unzip -q "/tmp/$BF" -d /opt/jre || fail "unzip failed"
      JAVA_HOME=$(find /opt/jre -maxdepth 1 -type d -name 'jdk*' | head -1) ;;
    *)
      tar xf "/tmp/$BF" -C /opt/jre --strip-components=1 || fail "untar failed"
      JAVA_HOME=/opt/jre ;;
  esac
  export JAVA_HOME
  export PATH="$JAVA_HOME/bin:$PATH"
fi
command -v java >/dev/null 2>&1 || fail "java still missing after bootstrap"
log "java: $(java -version 2>&1 | head -1)"

# 2. WebGoat executable jar, same API-based resolution and same reason
cd /tmp
WG_JAR_URL=$(curl -sSL https://api.github.com/repos/WebGoat/WebGoat/releases/latest \
  | grep -oE '"browser_download_url": *"[^"]*\.jar"' | head -1 | sed -E 's/.*"(https:[^"]*)"/\1/')
[ -n "$WG_JAR_URL" ] || fail "no webgoat jar asset found"
WG_FILE=$(basename "$WG_JAR_URL")
log "downloading $WG_FILE"
curl -sSL --retry 3 -o "/tmp/$WG_FILE" "$WG_JAR_URL" >>"$LOG" 2>&1 || fail "jar download failed"

# 3. launch (detached; WebGoat serves :8080 + WebWolf :9090)
mkdir -p "$DIR"
export JAVA_OPTS="-Xmx600m"
nohup java -jar "/tmp/$WG_FILE" --server.port=$PORT --webgoat.port=$PORT \
  </dev/null >>"$LOG" 2>&1 &
echo $! > /tmp/webgoat.pid
disown 2>/dev/null || true

# 4. readiness poll (JVM boot is slow: up to 5 min)
for i in $(seq 1 60); do
  sleep 5
  kill -0 "$(cat /tmp/webgoat.pid)" 2>/dev/null || { log "--- tail ---"; tail -40 "$LOG"; fail "jvm died during boot"; }
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "http://127.0.0.1:$PORT/WebGoat/login" || true)
  if [ "$CODE" = "200" ] || [ "$CODE" = "302" ]; then
    echo "READY http://localhost:$PORT (pid $(cat /tmp/webgoat.pid), $(basename $WG_FILE))" > "$STATUS"
    exit 0
  fi
done
fail "WebGoat never returned 200 within 5 min"
```

Both status files use the same contract: `READY <url>` on success, or
`FAILED <reason>` with the log tail appended. Read the file, not the shell's
exit code, before deciding the target is up.

## Investigate directly, no scope-guard round trip

Once the status file says `READY`, the target is a process inside your own
sandbox, listening on your own sandbox's `localhost:<port>`. Talk to it the
same way you'd talk to any other localhost service from inside that sandbox:
`curl`, your own scripted requests, browser automation if the mission needs
it. Do not call `scope_check`, `http_probe`, or `probe_target` for it.

That's a deliberate difference from a real report, not an oversight. Those
tools exist to mediate a capability boundary between the agent and a
separately provisioned reproduction target (see `agent/bountydesk.agent.json`
and `bountydesk-recon`'s Phase 0). DVWA and WebGoat here have no such
boundary to cross: you booted the process yourself, in the same sandbox
you're already running in, so there's nothing external to authorize contact
with. The rest of your investigation skills still apply as normal:
`bountydesk-challenges` for clearing DVWA's module/level matrix or WebGoat's
lesson set, `bountydesk-payloads` for the actual requests, and
`bountydesk-validation`'s five-check gate before writing up any finding.

## The honest limitation: this is not a pinned target

`git clone --depth 1` pulls whatever DVWA's `master` branch currently is, and
`releases/latest` pulls whatever WebGoat currently ships. Neither is pinned
to a commit or a digest, so the exact code under test can differ between two
runs, unlike the project's real target, the pinned Juice Shop fork at a fixed
commit (see `docs/decisions.md`, Q18). A finding here is reproducible against
"DVWA" or "WebGoat" as a moving target, not against one exact, verifiable
build.

That's fine for what this skill is for: a demo or a practice run against a
teaching app, where the point is to show the investigation working, not to
stand behind a specific commit. It is not fine for anything claiming to be an
authorized, reproducible bug-bounty target, and this skill must not be used
to back a real verdict. Say so plainly in any report this skill produces.

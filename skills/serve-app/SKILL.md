---
name: bountydesk-serve-app
description: Generic in-sandbox runner that clones a git repo (or unpacks a zip/tgz, or copies a local dir), auto-detects Node/Python/static, and serves it on a local port with the same READY/FAILED status-file contract as bountydesk-demo-targets. Use when a report names a connected repository and you need to boot and, if the report names a commit or tag, pin that repository yourself before investigating it. Does not cover DVWA or WebGoat; those are PHP and Java and need bountydesk-demo-targets instead.
---

# BountyDesk generic app runner

This is the other half of self-boot investigation. `bountydesk-demo-targets`
covers two specific, bespoke apps (DVWA, WebGoat). This skill covers
everything else: when a report names a connected GitHub or GitLab repository
and a claimed vulnerability, you can boot that repository yourself, inside
your own sandbox, the same way you'd boot a demo target, then pin it to the
exact state the report describes before you test anything.

This does not change how a report is authorized. BountyDesk still resolves
exactly one target per run, and that target is still named by the report, not
picked by you. What changes is that "the target is deployed" no longer means
someone else stood it up ahead of time: you can stand it up yourself, from the
repository the report names, with a real boot sequence instead of an
assumption.

## Boot it yourself: acquire, detect, serve, poll

Adapted from Sentinel's `sandbox-setup/serve-app.sh` and `lib.sh`. Run it as
one script via your sandbox's execute capability:

```bash
SRC="$1"                        # git URL, local dir, or .zip/.tgz URL
PORT="${2:-3000}"
LAB_STATUS=/tmp/lab_status.txt
LAB_LOG=/tmp/lab.log
LAB_DIR=/tmp/lab-app
LAB_PIDFILE=/tmp/lab.pid
LAB_OUT=/tmp/lab-out.log

echo "BOOTSTRAPPING $SRC port=$PORT" > "$LAB_STATUS"
: > "$LAB_LOG"
log() { echo "[lab] $*" >> "$LAB_LOG"; }
fail_lab() { echo "FAILED $1" > "$LAB_STATUS"; tail -40 "$LAB_LOG" >> "$LAB_STATUS" 2>/dev/null; exit 1; }

ensure_node22() {
  command -v node >/dev/null 2>&1 && { log "system node $(node -v)"; return 0; }
  log "bootstrapping Node 22 from nodejs.org/dist"
  local NV
  NV=$(curl -fsSL https://nodejs.org/dist/index.json \
       | grep -oE '"version":"v22\.[0-9]+\.[0-9]+"' | head -1 | grep -oE 'v[0-9.]+')
  [ -n "$NV" ] || fail_lab "could not resolve Node 22 version"
  local f="node-$NV-linux-x64.tar.xz"
  mkdir -p /opt/node22
  curl -fsSL "https://nodejs.org/dist/$NV/$f" -o "/tmp/$f" || fail_lab "nodejs.org download failed"
  tar xJf "/tmp/$f" -C /opt/node22 --strip-components=1 || fail_lab "tar extract failed"
  export PATH="/opt/node22/bin:$PATH"
  command -v node >/dev/null 2>&1 || fail_lab "node binary did not run after extract"
}

# Acquire <src> into $LAB_DIR: local dir, git URL, or .zip/.tgz.
acquire() {
  local src="$1"
  rm -rf "$LAB_DIR"; mkdir -p "$LAB_DIR"
  if [ -d "$src" ]; then cp -r "$src"/. "$LAB_DIR"/ && return 0; fi
  case "$src" in
    *.git|https://github.com/*|https://gitlab.com/*|git@*)
      git clone --depth 1 "$src" "$LAB_DIR" >>"$LAB_LOG" 2>&1 || fail_lab "git clone failed: $src" ;;
    *.zip|*.tgz|*.tar.gz)
      local f="$LAB_DIR/$(basename "$src")"
      curl -sSL --retry 3 -o "$f" "$src" || fail_lab "download failed: $src"
      case "$f" in
        *.zip) unzip -q "$f" -d "$LAB_DIR" || fail_lab "unzip failed" ;;
        *) tar xf "$f" -C "$LAB_DIR" || fail_lab "untar failed" ;;
      esac
      local sub; sub=$(find "$LAB_DIR" -mindepth 1 -maxdepth 1 -type d | head -1)
      if [ "$(find "$LAB_DIR" -mindepth 1 -maxdepth 1 | wc -l)" = "1" ] && [ -d "$sub" ]; then
        shopt -s dotglob; mv "$sub"/* "$LAB_DIR"/; rmdir "$sub"; shopt -u dotglob
      fi ;;
    *) fail_lab "unsupported source: $src (use dir, git URL, or .zip/.tgz)" ;;
  esac
}

# Detect Node (package.json), Python (requirements.txt / *.py), or fall back
# to serving the directory statically. Writes the PID to $LAB_PIDFILE.
start_app() {
  cd "$LAB_DIR" || fail_lab "lab dir missing"
  if [ -f package.json ]; then
    ensure_node22
    npm install --omit=dev --no-audit --no-fund >>"$LAB_LOG" 2>&1 || log "npm install reported errors (continuing)"
    local entry start_script
    entry=$(find . -path ./node_modules -prune -o -maxdepth 2 -type f \( -name server.js -o -name app.js -o -name index.js \) -print 2>/dev/null | head -1)
    start_script=$(node -e "try{console.log(require('./package.json').scripts.start||'')}catch(e){}" 2>/dev/null)
    if [ -n "$start_script" ]; then nohup npm start >"$LAB_OUT" 2>&1 &
    elif [ -n "$entry" ]; then nohup node "$entry" >"$LAB_OUT" 2>&1 &
    else log "package.json without start script or discoverable entry"; return 1; fi
    echo $! > "$LAB_PIDFILE"; return 0
  fi
  if [ -f requirements.txt ] || ls *.py >/dev/null 2>&1; then
    local py_entry
    py_entry=$(ls main.py app.py server.py 2>/dev/null | head -1)
    [ -n "$py_entry" ] || py_entry=$(find . -maxdepth 2 -name "*.py" | head -1)
    [ -n "$py_entry" ] || { log "no python entry found"; return 1; }
    (pip3 install -q -r requirements.txt 2>>"$LAB_LOG" || true)
    nohup python3 "$py_entry" >"$LAB_OUT" 2>&1 &
    echo $! > "$LAB_PIDFILE"; return 0
  fi
  log "no recognized app; serving directory statically"
  nohup python3 -m http.server "$PORT" --bind 127.0.0.1 >"$LAB_OUT" 2>&1 &
  echo $! > "$LAB_PIDFILE"
}

# Poll until the port answers; any HTTP code counts as listening.
wait_ready() {
  local deadline=$((SECONDS + 240))
  while [ $SECONDS -lt $deadline ]; do
    kill -0 "$(cat "$LAB_PIDFILE" 2>/dev/null)" 2>/dev/null || fail_lab "app process died during boot (see $LAB_OUT)"
    local code; code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$PORT/" || true)
    case "$code" in
      000|"") sleep 3 ;;
      *) echo "READY http://localhost:$PORT (HTTP $code)" > "$LAB_STATUS"; return 0 ;;
    esac
  done
  fail_lab "port $PORT never answered within 240s"
}

acquire "$SRC" || exit 1
start_app || fail_lab "could not start app"
wait_ready || exit 1
```

Same status-file contract as `bountydesk-demo-targets`: `READY <url>` or
`FAILED <reason>` in `/tmp/lab_status.txt`, with the log tail appended on
failure. Read that file before treating the target as up.

**What this doesn't cover.** No PHP branch, no Java branch. DVWA and WebGoat
need `bountydesk-demo-targets`' bespoke boot sequences instead; don't try to
run them through this one. `acquire()` also only does a shallow clone of the
repository's default branch, so it cannot check out an arbitrary named ref by
itself. That's what the next step is for.

## Pin to the state the report describes

`acquire()` gives you whatever the default branch currently is. If the
report or its advisory names a specific commit, tag, or version, testing
against the current default branch risks a false negative when the bug has
since been fixed upstream. After `acquire()` finishes and before `start_app`,
fetch and check out that exact ref (the initial clone is shallow, so an
arbitrary other commit isn't reachable without fetching it first):

```bash
cd "$LAB_DIR"
git fetch --depth 1 origin "<ref>" && git checkout FETCH_HEAD
```

Only then call `start_app` and `wait_ready`.

## Investigate the pinned checkout

1. **Read the source before writing a payload.** Grep the exact route,
   controller, or validation logic the report names, and check the dependency
   version in `package.json` or `requirements.txt` against what the report
   claims. This is `bountydesk-challenges`' §2b doctrine applied here: reading
   beats blind probing when source is available, and it always is here since
   you just cloned it.
2. **Cross-check the dependency version against public advisory data** with
   the host-side `osv_query` / `osv_get` MCP tools. They run outside the
   sandbox's restricted egress; don't try to curl OSV directly from inside
   the sandbox.
3. **Reproduce** with a `bountydesk-payloads` recipe if the vulnerability
   class matches one of its patterns, otherwise a technique-appropriate probe
   against `http://localhost:<port>`, the address `wait_ready` confirmed.
4. **Confirm via mutated state, not reflection**: command output, a written
   marker, a DOM mutation, the same evidence bar `bountydesk-validation`
   requires everywhere else.
5. **Negative control, strongly recommended.** If the advisory names a
   patched commit or tag, check that out, rerun the identical detector
   unmodified, and confirm it now reports not vulnerable. A positive result
   with no negative control is a weaker claim: this is what turns "found
   something" into a real repro.

## Scope-guard doesn't gate the clone

Cloning from GitHub or GitLab needs no scope-guard grant: the sandbox's
default egress already allows git hosts, the same way it allows package
registries. `scope_check` and `request_intrusive_approval` start mattering
once you're hitting an actual external network target for active testing.
After the pin-and-checkout step here, testing is against
`http://localhost:<port>` inside your own sandbox, not an external
destination, exactly like `bountydesk-demo-targets`: no `scope_check`,
`http_probe`, or `probe_target` call for it.

## Honest limitation

This still doesn't make BountyDesk a multi-target platform. The report still
names exactly one authorized repository; you don't get to pick a different
one, and there is still no dynamic per-repository target tier at intake (see
`docs/multi-target-expansion-plan.md` for that separate, larger work). What
this skill adds is a real way to boot and pin that one named repository
yourself, replacing an assumption that it was already deployed somewhere with
an actual, verifiable boot sequence.

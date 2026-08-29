---
name: bountydesk-mobile
description: Inert/low-priority today, irrelevant to BountyDesk's single web target. Mobile APK static-analysis path for the BountyDesk agent. Use when given an Android APK: static triage without a device, manifest analysis, hardcoded secret hunting, endpoint extraction, and dependency fingerprinting. Includes documented dynamic-analysis procedure (Frida/objection) for when a device/emulator is available.
---

# BountyDesk mobile APK playbook (static + documented dynamic)

Inert for now: BountyDesk's current target is a web application, not a
mobile app. This is ported from the Sentinel prototype and kept here in case
a future report ever hands the agent an APK to analyze.

Default mode: pure static triage inside the sandbox (no device, no emulator).
Pipeline: acquire, unpack, structure, secrets/endpoints, tool-backed static,
dynamic (documented, device-required), correlate.

## Phase 1: acquire

`scope_check` the APK's host before fetching it, exactly like any other
network contact: the sandbox's egress allowlist reaching GitHub is not the
same thing as GitHub being an authorized target, and a URL living on GitHub
doesn't bypass the server-held `TargetProfile` that scope is bound to.

```bash
curl -sSL <apk-url> -o /tmp/artifacts/app.apk   # APK is a zip container
mkdir -p /tmp/artifacts/apk && cd /tmp/artifacts/apk
unzip -q -o ../app.apk
```

If fetch fails (network/scope, or no APK is available for this report), say
so plainly rather than fabricating an APK to analyze.

## Phase 2: structure

```bash
ls -la; ls -la lib/ assets/ res/raw 2>/dev/null
file classes*.dex
```

Note native libs (`lib/*/lib*.so`); architecture and unusual libs are
findings.

## Phase 3: secrets and endpoints (strings-level, no jadx required)

```bash
for f in res/values/strings.xml assets/* classes*.dex; do
  [ -f "$f" ] && strings -n 8 "$f" >> /tmp/artifacts/apk/all.strings
done
grep -aiE 'https?://[a-z0-9./_-]+' /tmp/artifacts/apk/all.strings \
  | sort -u | tee /tmp/artifacts/apk/endpoints.txt
grep -aiE 'api[_-]?key|secret|token|password|BEGIN (RSA|EC)? ?PRIVATE' \
  /tmp/artifacts/apk/all.strings | sort -u | head -50 \
  | tee /tmp/artifacts/apk/secrets_candidates.txt
```

- Endpoints discovered become POTENTIAL live targets: `scope_check` each host
  before any contact; unscoped hosts go into the report as "endpoints
  requiring authorization," never contacted directly.
- Secret candidates: verify by context (surrounding strings), dedupe, mark
  `verified:false` unless confirmed against a live endpoint the operator
  scoped.

## Phase 4: tool-backed static (feasible without a device)

`androguard`, `apkleaks`, and `mobsfscan` are pip-installable (may require
`--break-system-packages` on an externally-managed Python). `frida-tools` and
`objection` are installable but only useful with a device attached. Don't
block the report if install is denied; fall back to strings-level and note
the limitation.

```bash
# install (if allowed)
pip3 install --break-system-packages -q androguard apkleaks mobsfscan

# androguard: manifest + permissions without jadx
androguard axml /tmp/artifacts/app.apk          # binary AndroidManifest.xml decode
androguard apkid /tmp/artifacts/app.apk         # packageName / versionCode / versionName

# apkleaks: endpoint + secret pattern scan (LinkFinder + regex pack)
apkleaks -f /tmp/artifacts/app.apk --json -o /tmp/artifacts/apk/apkleaks.json
cat /tmp/artifacts/apk/apkleaks.json | python3 -m json.tool | head -80

# mobsfscan: SAST rules over unpacked sources (works on unpacked dir or APK)
mobsfscan /tmp/artifacts/apk --json -o /tmp/artifacts/apk/mobsfscan.json
# alternative for source-tree scans: mobsfscan --type android /tmp/artifacts/apk
```

Keep all three outputs as `evidence_ref` artifacts. When tools are
unavailable, state it explicitly in the report; strings-level findings
remain valid with lower confidence.

## Phase 5: dynamic analysis (requires device), documented, not executed in sandbox

Booting an emulator or attaching a real device requires USB/network access
and time, and is out of scope for the sandbox. `frida-server` must run on the
device; without it every Frida/objection command fails fast. This section is
a documented procedure to run when a device is available.

### 5a. Device readiness checklist

```bash
adb devices                          # must list one device/emulator
adb shell getprop ro.build.version.release
adb install /tmp/artifacts/app.apk   # or: adb install -r app.apk
adb shell pm list packages | grep <package>
# Push a matching frida-server for the device arch (download from https://github.com/frida/frida/releases)
adb push frida-server /data/local/tmp/frida-server && adb shell "chmod 755 /data/local/tmp/frida-server"
adb shell "/data/local/tmp/frida-server &"
frida-ps -U                           # should list device processes
```

Do not proceed until `frida-ps -U` succeeds. Record device `ro.build` props
and `frida --version` in the report header.

### 5b. Frida hook template (save as /tmp/frida_hooks.js)

```javascript
// Usage: frida -U -f com.example.app -l /tmp/frida_hooks.js --no-pause
// Or attach: frida -U -n com.example.app -l /tmp/frida_hooks.js
'use strict';
console.log('[*] hook loaded');

Java.perform(function () {
  // 1. SSL pinning bypass (OkHttp3), best-effort, log only
  try {
    var Pinning = Java.use('okhttp3.CertificatePinner');
    Pinning.check.overload('java.lang.String', 'java.util.List').implementation = function (a, b) {
      console.log('[pinning] bypass check for ' + a); return;
    };
  } catch (e) { console.log('[pinning] not found: ' + e.message); }

  // 2. Log HTTP URLs at runtime
  try {
    var URL = Java.use('java.net.URL');
    URL.$init.overload('java.lang.String').implementation = function (s) {
      console.log('[url] ' + s); return this.$init(s);
    };
  } catch (e) {}

  // 3. Dump SharedPreferences / keystore access hints
  try {
    var SP = Java.use('android.content.SharedPreferences');
    // actual exfil via objection is preferred; this is a tripwire
  } catch (e) {}
});

// Native: intercept common crypto / file writes if needed
// Interceptor.attach(Module.findExportByName(null, 'open'), { onEnter(args){ console.log('[open] ' + Memory.readUtf8String(args[0])); }});
```

Run:

```bash
frida -U -f com.example.app -l /tmp/frida_hooks.js --no-pause
# In another shell, exercise the app manually or via adb shell am start
frida -U -n com.example.app -l /tmp/frida_hooks.js   # attach to running
frida-trace -U -i open -i connect -j '*!*decrypt*/*encrypt*' com.example.app
```

### 5c. Objection runtime (no custom JS needed)

```bash
objection --gadget com.example.app explore
# inside objection REPL:
android hooking list activities
android hooking list services
android hooking list receivers
android sslpinning disable
android root disable
android intent launch_activity com.example.app.MainActivity
memory list modules
memory search "https://*"
android sharedpreferences get --package com.example.app
android keystore list
android hooking watch class okhttp3.OkHttpClient --dump-args --dump-return
exit
# headless one-liners:
objection -g com.example.app run android sslpinning disable
objection -g com.example.app run android hooking list activities
```

### 5d. Checklist before marking dynamic findings verified

- [ ] Device/emulator booted and `adb devices` plus `frida-ps -U` ok
- [ ] Correct `frida-server` arch pushed and running
- [ ] App installed and launched under Frida or objection
- [ ] Endpoints observed via hooks/trace (not just static strings)
- [ ] Secrets observed at runtime (memory/sharedprefs/keystore); redact in
      report, `verified:true` only if replay against a scoped host succeeds
- [ ] All runtime hosts scope-checked before any live contact; unscoped hosts
      stay as "requires authorization"

If any box is unchecked, report dynamic coverage as `NOT ATTEMPTED, no
device` with this checklist as the plan for the next run.

## Report contract

Same ranked DRAFT format as `bountydesk-triage`, with mobile-specific
classes: hardcoded credentials, embedded API endpoints, weak crypto
references, exported components (from permission strings), framework EOL
notes. Every finding needs an `evidence_ref` into `apk/` artifacts plus a
`because` sentence per `bountydesk-validation` gates. Tool-backed vs
strings-only vs dynamic-observed must be labeled per finding.

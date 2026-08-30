---
name: bountydesk-firmware
description: Inert/low-priority today, irrelevant to BountyDesk's single web target. Firmware/hardware-image triage for the BountyDesk agent. Use when given a firmware binary, router/OpenWrt image, or embedded filesystem to analyze: signature scan, filesystem extraction, secret hunting, and CVE mapping against the identified stack.
---

# BountyDesk firmware triage playbook

Inert for now: BountyDesk's current target is a web application, not a
firmware image. This is ported from the Sentinel prototype and kept here in
case a future report ever hands the agent a firmware artifact to analyze.

Firmware is opaque blobs hiding filesystems. The pipeline: identify, extract,
hunt, correlate. Everything runs in the sandbox; images stay in artifacts.

## Phase 1: identify (no approval needed; read-only on the file)

```bash
file <image> && ls -la <image>
pip3 install -q binwalk pyelftools 2>/dev/null || true
binwalk <image> | tee /tmp/artifacts/firmware/binwalk.txt
```

Record from binwalk signatures: compression types (gzip/lzma/xz), filesystem
offsets (squashfs/jffs2/cramfs), kernel headers (uImage), bootloader sections
(u-boot), certificates.

## Phase 2: extract (grant-gated if the image is operator-provided production firmware; lab images need no grant)

```bash
mkdir -p /tmp/artifacts/firmware/rootfs
dd if=<image> bs=1 skip=<squashfs_offset> count=<size> of=/tmp/artifacts/firmware/root.squashfs
# unsquashfs if available (apt install squashfs-tools); else fall back to
# string-level triage below
unsquashfs -d /tmp/artifacts/firmware/rootfs /tmp/artifacts/firmware/root.squashfs \
  || echo "unsquashfs unavailable, recording limitation"
```

If extraction tools are missing, say so and fall back to string-level triage:

```bash
strings -n 8 <image> > /tmp/artifacts/firmware/strings.txt
grep -aiE 'shadow|passwd|private key|BEGIN RSA|api[_-]?key|secret' \
  /tmp/artifacts/firmware/strings.txt | head -50
```

## Phase 3: hunt (on extracted rootfs or strings)

Priority targets, in order:
1. Credentials: `/etc/shadow`, `/etc/passwd`, wpa_supplicant.conf,
   hardcoded `password|secret|key` in /etc/config/*, web-app configs.
2. Private keys/certs: `*.key`, `*.pem`, `id_rsa`.
3. Services: `/etc/init.d/` scripts starting telnetd, busybox telnet,
   upnpd, debug shells (`console:::respawn`).
4. Version fingerprint: `/etc/openwrt_release`, `/etc/os-release`, banner
   strings, then feed `osv_query` for the identified components (busybox,
   dropbear, openssl, lighttpd versions from opkg status or strings).
5. **Web root** (/www): hard-coded creds in JS, debug endpoints.

## Rules

- Firmware files are EVIDENCE: copy to artifacts before any modification;
  never write to the original.
- Correlate component versions via host-side osv tools (same as the API
  path).
- Report format matches `bountydesk-triage`: ranked table plus evidence refs.
- If extraction is impossible with available tooling, deliver the binwalk map
  plus string-level findings and state the limitation plainly.

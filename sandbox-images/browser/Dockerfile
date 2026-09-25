# The browser probe sandbox image.
#
# This is BountyDesk's own image, not a target's. It boots as a reproduction-grade sandbox
# (networkBlockAll, no egress) link-joined to the target's sandbox, and runs the target's page in a
# real headless browser so a DOM/SPA XSS can be observed. See docs/browser-probe.md for why the
# browser lives here and not in the target's sandbox or on the host.
#
# Build this, push it to the registry the reproduction runner pulls from, register it as a Daytona
# snapshot, and set BOUNTYDESK_BROWSER_SNAPSHOT and BOUNTYDESK_BROWSER_IMAGE_REF (its digest-pinned
# ref) in the reproduction worker's env. Until both are set the browser probe is off and nothing
# here runs (browserProbeConfig() returns null).
#
# The base carries a real Chromium so the probe never downloads a browser at run time (it cannot:
# no egress). node is needed for webcmd and for browser-oracle.mjs. curl is needed because
# verifyNoEgress and the readiness checks probe with it from inside the sandbox.

FROM node:20-bookworm-slim

# Chromium plus the shared libraries a headless Chromium needs, and curl for the egress self-check.
# ca-certificates is harmless and keeps TLS libraries happy even though nothing here reaches the
# internet.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      curl \
      ca-certificates \
      fonts-liberation \
      libnss3 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdrm2 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libasound2 \
    && rm -rf /var/lib/apt/lists/*

# webcmd is installed here so it, and the Chromium it drives, are baked in and run fully offline.
# The install is the one moment network is allowed, at build time only. Pinned because
# browser-oracle.mjs depends on webcmd internals (its result envelope and config.json format).
RUN npm install -g @agentrhq/webcmd@0.8.4

# webcmd picks its browser from $WEBCMD_CONFIG_DIR/config.json, not from env; with no config it
# downloads its own Cloak Chromium, which fails offline. The `custom` kind points it at the system
# Chromium. webcmd always launches headed (headless: false is hardcoded) and there is no X server
# here, so the configured executable is a wrapper that adds --headless=new. The config dir is
# world-writable because webcmd keeps its profile and session state there and the sandbox's exec
# user is not guaranteed to be root.
RUN printf '#!/bin/sh\nexec /usr/bin/chromium --headless=new "$@"\n' > /usr/local/bin/chromium-headless \
    && chmod 755 /usr/local/bin/chromium-headless \
    && mkdir -p /opt/webcmd \
    && printf '%s\n' '{"mode":"local","updatedAt":"2026-09-25T00:00:00.000Z","browser":{"kind":"custom","executablePath":"/usr/local/bin/chromium-headless"}}' > /opt/webcmd/config.json \
    && chmod 777 /opt/webcmd && chmod 644 /opt/webcmd/config.json

# Disable webcmd's two optional outbound calls (the sandbox blocks them anyway; this stops the
# wasted attempts). browser-oracle.mjs sets all three again for its own child processes.
ENV WEBCMD_GLOBAL_MEMORY=off \
    WEBCMD_CANDIDATE_PUBLIC_IP=off \
    WEBCMD_CONFIG_DIR=/opt/webcmd

COPY browser-oracle.mjs /opt/bountydesk/browser-oracle.mjs

# The sandbox is driven entirely through Daytona's exec API (the host runs
# `node /opt/bountydesk/browser-oracle.mjs <params>`), so the image needs no long-running
# entrypoint of its own. It idles until the runner execs into it.
CMD ["sleep", "infinity"]

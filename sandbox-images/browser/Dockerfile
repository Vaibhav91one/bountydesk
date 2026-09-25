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
# The install is the one moment network is allowed, at build time only. If webcmd's bundled Cloak
# Chromium cannot be fetched offline in your build, point webcmd at the system chromium below.
RUN npm install -g @agentrhq/webcmd

# Point webcmd at the system Chromium so it never needs its own download at run time, and disable
# its two optional outbound calls (the sandbox blocks them anyway; this stops the wasted attempts).
ENV WEBCMD_GLOBAL_MEMORY=off \
    WEBCMD_CANDIDATE_PUBLIC_IP=off \
    WEBCMD_BROWSER=/usr/bin/chromium \
    CHROME_PATH=/usr/bin/chromium

# If your webcmd version needs an explicit setup step to record the browser path, run it at build
# time (it must not need network):
#   RUN webcmd setup --browser /usr/bin/chromium || true

COPY browser-oracle.mjs /opt/bountydesk/browser-oracle.mjs

# The sandbox is driven entirely through Daytona's exec API (the host runs
# `node /opt/bountydesk/browser-oracle.mjs <params>`), so the image needs no long-running
# entrypoint of its own. It idles until the runner execs into it.
CMD ["sleep", "infinity"]

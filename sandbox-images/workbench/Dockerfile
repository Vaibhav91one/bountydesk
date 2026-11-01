# The pentest workbench sandbox image (Phase 0, issue #327).
#
# This is BountyDesk's own image, not a target's. It boots as a reproduction-grade sandbox
# (networkBlockAll, no egress) link-joined to the target's sandbox, and runs httpx, nuclei, or
# newman against the server-bound target origin so the agent can gather recon and structured leads.
# Workbench output is untrusted evidence only; the canary oracle stays the sole gate for REPRODUCED.
# See docs/pentest-workbench.md.
#
# Build this, push it to the registry the reproduction runner pulls from, register it as a Daytona
# snapshot, and set BOUNTYDESK_WORKBENCH_SNAPSHOT, BOUNTYDESK_WORKBENCH_IMAGE_REF (its digest-pinned
# ref), and BOUNTYDESK_WORKBENCH_IMAGE_NAME (the tag) in the worker's env, plus
# BOUNTYDESK_WORKBENCH_ENABLED=1 to turn the tool on for the agent. Until the flag is set and all
# three image values are present the workbench probe is off and nothing here runs
# (workbenchProbeConfig() returns null).

FROM node:20-bookworm-slim

ARG TARGETARCH=amd64
ARG HTTPX_VERSION=1.6.10
ARG NUCLEI_VERSION=3.3.9

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
      ca-certificates \
      unzip \
    && rm -rf /var/lib/apt/lists/*

# Install httpx and nuclei static binaries plus the default nuclei templates at build time so the
# runtime sandbox needs zero network access.
RUN ARCH=$(case "${TARGETARCH}" in arm64|aarch64) echo "arm64" ;; *) echo "amd64" ;; esac) \
    && curl -fsSL "https://github.com/projectdiscovery/httpx/releases/download/v${HTTPX_VERSION}/httpx_${HTTPX_VERSION}_linux_${ARCH}.zip" -o /tmp/httpx.zip \
    && unzip -q /tmp/httpx.zip httpx -d /usr/local/bin/ \
    && chmod 755 /usr/local/bin/httpx \
    && rm -f /tmp/httpx.zip \
    && curl -fsSL "https://github.com/projectdiscovery/nuclei/releases/download/v${NUCLEI_VERSION}/nuclei_${NUCLEI_VERSION}_linux_${ARCH}.zip" -o /tmp/nuclei.zip \
    && unzip -q /tmp/nuclei.zip nuclei -d /usr/local/bin/ \
    && chmod 755 /usr/local/bin/nuclei \
    && rm -f /tmp/nuclei.zip

# newman for running Postman collections offline against API targets.
RUN npm install -g newman@6.2.1

# Build-identity marker read back from inside the booted sandbox (build-marker.ts's MARKER_PATH).
# Must match EXPECTED_WORKBENCH_BUILD_MARKER in lib/sandbox/workbench-probe.ts.
RUN printf %s 'workbench-out-1' > /etc/bountydesk-build-marker

COPY workbench-runner.mjs /opt/bountydesk/workbench-runner.mjs

CMD ["sleep", "infinity"]

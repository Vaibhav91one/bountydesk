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

# Set by BuildKit to the platform being built; a default here would override it and install the
# wrong-arch binaries. An empty value falls through to amd64 in the case below.
ARG TARGETARCH
ARG HTTPX_VERSION=1.6.10
ARG NUCLEI_VERSION=3.3.9

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
      ca-certificates \
      unzip \
    && rm -rf /var/lib/apt/lists/*

# Install the httpx and nuclei static binaries at build time so the runtime sandbox needs zero
# network access. Each zip is checked against the sha256 from the release's own checksums file
# (pinned per version and arch below), so a substituted release asset fails the build instead of
# landing in /usr/local/bin. Bumping a version means updating its two hashes.
ARG HTTPX_SHA256_AMD64=e7eb8473530c2d0eb4eb132c7253c0138745d622970f36413c1f349ddd60edb7
ARG HTTPX_SHA256_ARM64=e1555e7ef5c8d510da1de823c0f9f0313f5518b6db7c9269c06f51e184b85d6b
ARG NUCLEI_SHA256_AMD64=dfecedc31364d70b7291b347c74fd4d1d3185d30301c025b7490717d29daf28a
ARG NUCLEI_SHA256_ARM64=f4040212673de766919fe2a9deeb77a307865124701f2f6a4ae8f4dc7b3c18e9
RUN ARCH=$(case "${TARGETARCH}" in arm64|aarch64) echo "arm64" ;; *) echo "amd64" ;; esac) \
    && if [ "${ARCH}" = arm64 ]; then HTTPX_SHA="${HTTPX_SHA256_ARM64}"; NUCLEI_SHA="${NUCLEI_SHA256_ARM64}"; \
       else HTTPX_SHA="${HTTPX_SHA256_AMD64}"; NUCLEI_SHA="${NUCLEI_SHA256_AMD64}"; fi \
    && curl -fsSL "https://github.com/projectdiscovery/httpx/releases/download/v${HTTPX_VERSION}/httpx_${HTTPX_VERSION}_linux_${ARCH}.zip" -o /tmp/httpx.zip \
    && echo "${HTTPX_SHA}  /tmp/httpx.zip" | sha256sum -c - \
    && unzip -q /tmp/httpx.zip httpx -d /usr/local/bin/ \
    && chmod 755 /usr/local/bin/httpx \
    && rm -f /tmp/httpx.zip \
    && curl -fsSL "https://github.com/projectdiscovery/nuclei/releases/download/v${NUCLEI_VERSION}/nuclei_${NUCLEI_VERSION}_linux_${ARCH}.zip" -o /tmp/nuclei.zip \
    && echo "${NUCLEI_SHA}  /tmp/nuclei.zip" | sha256sum -c - \
    && unzip -q /tmp/nuclei.zip nuclei -d /usr/local/bin/ \
    && chmod 755 /usr/local/bin/nuclei \
    && rm -f /tmp/nuclei.zip

# nuclei templates, pinned to a release tag and verified by sha256 like the binaries. Without them a
# nuclei run loads zero templates, because the sandbox has no network and the runner passes -duc.
# workbench-runner.mjs passes -t /opt/nuclei-templates and refuses to scan if the directory is empty.
ARG NUCLEI_TEMPLATES_VERSION=10.5.1
ARG NUCLEI_TEMPLATES_SHA256=30fe1cfaced4635f886e4a2673641bba86998dceec28e468274524e789aa56eb
RUN curl -fsSL "https://github.com/projectdiscovery/nuclei-templates/archive/refs/tags/v${NUCLEI_TEMPLATES_VERSION}.tar.gz" -o /tmp/nt.tgz \
    && echo "${NUCLEI_TEMPLATES_SHA256}  /tmp/nt.tgz" | sha256sum -c - \
    && mkdir -p /opt/nuclei-templates \
    && tar -xzf /tmp/nt.tgz -C /opt/nuclei-templates --strip-components=1 \
    && rm -f /tmp/nt.tgz \
    && test -n "$(find /opt/nuclei-templates -name '*.yaml' -print -quit)"

# newman for running Postman collections offline against API targets.
RUN npm install -g newman@6.2.1

# Build-identity marker read back from inside the booted sandbox (build-marker.ts's MARKER_PATH).
# Must match EXPECTED_WORKBENCH_BUILD_MARKER in lib/sandbox/workbench-probe.ts.
RUN printf %s 'workbench-out-3' > /etc/bountydesk-build-marker

COPY workbench-runner.mjs /opt/bountydesk/workbench-runner.mjs

CMD ["sleep", "infinity"]

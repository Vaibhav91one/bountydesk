# Browser probe for DOM/SPA XSS reproduction

A plain HTTP fetch never runs the page's JavaScript, so `probe_target` and the HTTP reproduction
oracle are blind to any bug that only fires in a browser: DOM XSS, a `location.hash` to `innerHTML`
sink, a client-side redirect. A verdict on such a report flips when a fetch cannot see the
execution (memory: dom-xss-http-probe-blind). This adds a real headless browser to close that gap,
built so it never becomes an exfiltration hole.

The driver is webcmd (`@agentrhq/webcmd`), which runs Playwright over a Chromium baked into the
image. It is used purely as a scripted, offline browser: no LLM, no cloud, no telemetry.

## Where the browser runs, and why

The browser executes the target's own JavaScript, which makes it an SSRF and exfiltration pivot: a
page can `fetch()` anywhere or post out whatever it scraped. So the browser runs in neither of the
two obvious places.

Not on the BountyDesk host: the host has internet, and a page that ran there could reach it.

Not in the target's own sandbox: the run's canary must be unguessable to the target. It rides in
the URL fragment (which a browser never sends to a server) and lives only in the browser's memory
and process arguments. A browser sharing the target's sandbox would leak the canary to the target
through the shared filesystem and `/proc`, and an adversarial target could echo it back to fake a
`REPRODUCED`.

It runs in its own reproduction-grade sandbox: `networkBlockAll`, no egress, torn down after the
run, link-joined to the target's sandbox so the only thing it can reach is the one target app, by
the target's sandbox id, over a private in-group route. `verifyNoEgress` proves the block held
before any page loads, the same proof `provisionTarget` makes for the target sandbox. This reuses
the linked-sandbox mesh that is already proven for multi-service targets (memory:
linked-sandbox-mesh-proven).

## The oracle boundary still holds

`reproduce.ts`'s rule is that a `REPRODUCED` gate is read by BountyDesk's own trusted code, never
lifted from attacker-influenced exec stdout (`lib/reproduction/types.ts`). That still holds. The
browser sandbox is BountyDesk's own image, isolated from the target, so its stdout is trusted code
reporting what it rendered. The rendered DOM it returns is attacker-influenced content, exactly
like the HTTP oracle's response body, and BountyDesk greps that content for the run's secret canary
itself (`runBrowserOracle` in `lib/sandbox/browser-probe.ts`). The target cannot put the canary
there without the injected sink firing, because it never learns the canary.

Confirmation is a canary in a specific sink, never a bare `alert()`:

- `title`: the payload sets `document.title` to the run canary. Only script can set the title, so a
  fragment reflected into the page as inert text never lands there. Works with any DOM-mutation
  payload and is the robust default.
- `dialog`: the payload calls `alert`/`confirm`/`prompt` with the canary, captured by a hooked
  dialog handler. Needs webcmd's Playwright dialog hook (see the caveat below).

A negative control (an inert payload carrying the same canary) must leave the sink clean, or the
run is `ANALYSIS_ONLY`, the same clean-negative-control rule the HTTP oracle has.

## What is built here, and what the operator still has to do

Built and tested on the host side, with the browser faked in CI:

- `lib/sandbox/browser-probe.ts`: provisions the isolated browser sandbox, proves no egress, drives
  the in-sandbox driver, greps the sink for the canary, tears the sandbox down.
- `lib/mcp/probe-browser.ts` and the `probe_browser` tool: the agent-facing probe.
- `lib/sandbox/reproduce.ts`: the deterministic browser oracle leg, run when a recipe declares
  `browserExploit`.
- `sandbox-images/browser/browser-oracle.mjs`: the in-sandbox webcmd driver, baked into the image.

Still to do, because the image build and snapshot are outside this change (the orchestrator owns
the snapshot rebuild and deploy):

1. Build `sandbox-images/browser/Dockerfile`, push it, and register it as a Daytona snapshot.
2. Set `BOUNTYDESK_BROWSER_SNAPSHOT` (the snapshot id) and `BOUNTYDESK_BROWSER_IMAGE_REF` (its
   digest-pinned ref) in the reproduction worker's env. Until both are set the feature is off:
   `browserProbeConfig()` returns null, `probe_browser` refuses cleanly, and the reproduce leg is
   never reached.
3. Verify webcmd offline in the built image: `webcmd doctor` green with no network, a `page.goto`
   plus DOM dump against a local page, and confirm no egress. Confirm `page.on('dialog')` and
   `page.on('console')` fire in webcmd's QuickJS runtime. They are Playwright-standard but webcmd
   does not document them; if the dialog hook does not fire, the `title` sink still works and a
   `dialog`-sink recipe should not be enabled until it does.
4. Author and review a `browserExploit` recipe before any live DOM-XSS reproduction. No frozen
   recipe declares one today, so nothing flips a verdict until a maintainer adds and reviews one.
5. Point the agent at `probe_browser`. The tool is registered and discoverable now, but the agent
   instructions (`agent/bountydesk.agent.json` and the driver turn message in
   `lib/analysis/trueforge-driver.ts`) still only name `probe_target`. Add a line for client-side
   bugs once the image is live, so the agent does not reach for a tool that only answers "not
   configured" until then.

## Threat controls in one place

- No egress: the browser sandbox is `networkBlockAll` and `verifyNoEgress` proves it before any
  page loads. webcmd's two optional outbound calls are disabled by env and blocked by the sandbox
  regardless.
- Origin lock: the only navigable origin is the target's, built from the target's server-held
  sandbox id and port; each step's server-visible path is origin-checked, and the fragment (the
  one place a payload rides) cannot change a URL's origin.
- Canary secrecy: the canary rides only in the fragment (never sent to the server) and lives only
  in the isolated browser sandbox (never readable by the target).
- No exec injection: the host's exec command is a fixed string plus one opaque base64 data
  argument; recipe and agent input arrive as data in a file, never spliced into a shell.
- Human gate untouched: `publish_verdict` still requires human approval of the exact text.

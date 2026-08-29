---
name: bountydesk-triage
description: Vulnerability triage for the BountyDesk agent. Use after recon artifacts exist. Correlates findings against public CVE data and ranks by real exploitability. Today's publish_verdict tool takes a single capability token and resolves verdict content server-side; the sections below on drafting outcome/summary/findings apply once the agent-authored-verdict path (a separate, not-yet-merged change) lands, not to the currently active agent.
---

# BountyDesk triage playbook

Input: recon JSONL artifacts (e.g. `artifacts/<host>.recon.jsonl`,
`artifacts/<host>.web.jsonl`).

**Current contract:** the active `publish_verdict` tool accepts only the exact
`capability` string handed to you in the turn message, and the verdict it
delivers is resolved server-side, not from anything you write. The current
agent's instructions are explicit that the model never drafts or narrates the
verdict. If that's the tool you have, your output here is the inventory and
correlation below, handed back as plain text for a human or a calling skill
to read; do not attempt to pass an outcome, summary, or findings payload into
`publish_verdict` today.

The rest of this skill (the "drafting" section) describes the target shape
once BountyDesk's agent-authored-verdict path ships: `publish_verdict` will
then take a real content payload, and this is where that content comes from.

## Procedure

1. Inventory: read the artifacts, list distinct services, versions, and
   web tech. No network calls needed for this.
2. CVE correlation: use the host-side OSV MCP tools (the sandbox cannot
   reach api.osv.dev; these tools run outside it):
   - `osv_query` with `{name, ecosystem, version}` per versioned package
     found in the inventory. Ecosystem examples: `npm`, `PyPI`, `Go`.
   - `osv_get` with an advisory id for full details on anything promising.
   Only correlate advisories whose affected ranges plausibly cover the
   observed version. If a lookup fails or returns nothing, mark findings
   `unverified` instead of guessing.
3. Reachability reasoning: downgrade CVEs that require conditions the
   recon did not confirm (auth bypass needing an admin route that returned
   404, etc.). Upgrade ones matching observed surface. Every verdict gets a
   one-line `because:` justification.
4. Severity (draft): rank by confirmed-exploitable, then
   exposed-sensitive-path, then outdated-but-patched-unknown, then info. Map
   to CVSS when OSV returned a score.

## Drafting the publish_verdict fields (forward-looking, see the contract note above)

Once the agent-authored-verdict path is active, `publish_verdict` becomes the
delivery mechanism, not a report file: your job is to arrive at that call
with an outcome you can defend, a summary a human can read in one pass, and a
findings list each entry of which already passed the `bountydesk-validation`
5-check gate. (The exact argument names and shapes are defined by the tool
schema itself; don't invent field names here, describe the content you're
assembling.) Keep the same discipline the old per-host report format
enforced:

- State scope authorization (which scope entry matched) and whether a grant
  was used, so a human reviewer can see the chain of custody.
- Group findings by severity, each with its evidence reference, its impact in
  one sentence, and a proposed fix in one sentence.
- Never invent CVEs. If correlation is empty, say so plainly; a clean result
  is a valid result.
- Every severity is a DRAFT until a human approves the exact `publish_verdict`
  content; nothing here is delivered on your say-so.
- Remediation advice stays advisory: propose fixes, never apply changes to
  the target. Fixing is out of scope and would need its own approval flow.

## Wrap-up rule

The final draft MUST be delivered as a pure-text answer with zero further
tool calls before you call `publish_verdict`. Reference artifact paths
instead of re-reading them.

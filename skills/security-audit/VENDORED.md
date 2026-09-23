# Vendored from Cloudflare

Source: https://github.com/cloudflare/security-audit-skill
Commit: `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`
Path in source: `skills/security-audit/`
License: MIT, Copyright Cloudflare, Inc. The license travels with it in `LICENSE`.

Every file here is the upstream file unchanged, with one exception: the frontmatter of
`SKILL.md`. Two fields were rewritten and nothing else in any file was touched.

`name` is `bountydesk-security-audit`, not `security-audit`. `desiredSkills()` in
`lib/trueforge/desired.ts` registers a skill under the name its frontmatter declares, not its
directory, and every BountyDesk skill carries the `bountydesk-` prefix so the agent manifest
can tell ours from anything else TrueForge holds.

`description` steers the agent to the skill's own guidance mode. Upstream offers two modes
and says so itself: guidance by default, and a full audit that runs six phases with parallel
sub-agents over a whole repository and writes artifacts to disk. Agent Bounty triages one inbound
report per turn, on `gpt-5-mini` with an iteration limit of 60, inside a sandbox with no
egress. A full audit would spend the whole budget before reaching the report, and the artifacts
it writes have nowhere to go. Guidance mode is the part that fits: classifying a report, naming
the affected principal and the trust boundary it crosses, and writing a finding with evidence
and the smallest effective fix.

The two Node validators and their tests are kept for fidelity but nothing here runs them. The
repo's test glob does not match `*.test.cjs`, and the validators check the full-audit mode's
output files, which guidance mode does not write.

To update: fetch the new commit into this directory, reapply the two frontmatter fields above,
and change the commit recorded here. Review the upstream diff for anything that would widen what
the agent executes, since a skill is instructions the agent follows.

# BountyDesk: agent-led bug bounty triage with a human-approved verdict

Suggested place to publish: Dev.to.

Dev.to is the best first home for this post. The audience already understands
developer tools, GitHub workflows, security demos, and AI agents. It gives you a
clean public URL for the hackathon submission, supports Markdown and inline
images, and is easy to share.

Hashnode is the backup if you want the post under a personal domain. After the
Dev.to post is live, share the link on LinkedIn, X, the WeMakeDevs community,
and the project README.

Suggested tags: `trueforge`, `ai-agents`, `security`, `github`, `hackathon`.

The image URLs below point at `main`. They will render on Dev.to after this
branch is merged. If you publish before merge, replace `main` with the pushed
branch name. The architecture images are exported from the BountyDesk FigJam
board. Dev.to does not reliably support interactive carousels in Markdown, so
the post uses a stacked architecture gallery instead.

Use the title above as the post title. The publishable post starts below.

---

# BountyDesk: agent-led bug bounty triage with a human-approved verdict

Bug bounty triage has an automation trap.

It is tempting to take an incoming report, run a few scripted checks, and post a
canned answer. That is fast, but it is not a triage desk. Real triage needs
judgment. The system has to know which target is authorized, whether the report
is in scope, what actually happened during reproduction, and when a human needs
to stop the machine before it speaks for the program.

BountyDesk is my answer to that problem: an agent-assisted bug-bounty triage desk
built on the TrueForge agent harness.

<img src="https://raw.githubusercontent.com/Vaibhav91one/bountydesk/main/docs/screenshots/approval-gate.png" alt="BountyDesk approval gate showing an agent-drafted verdict waiting for a reviewer to approve or deny">

*The product promise is visible at the gate: the agent can draft, but a human
has to approve or deny the exact words.*

The platform takes a GitHub issue, authenticates it through a GitHub App webhook,
binds it to a server-owned target profile, and sends it to a TrueForge agent.
The agent investigates the report against an isolated target sandbox, drafts a
verdict, and calls an approval-gated tool. The reporter receives nothing until a
human approves the exact comment.

The shortest version is:

```text
GitHub issue
  -> signed intake
  -> durable worker
  -> TrueForge agent session
  -> sandbox investigation
  -> approval-gated verdict draft
  -> reviewer approval
  -> idempotent GitHub comment
```

That last line matters. The system does not auto-close reports, and it does not
let the model publish directly. The agent does the work. The human signs the
output.

## Architecture

The architecture has three separate trust zones.

The browser only talks to the Next.js app. It never talks directly to TrueForge,
Daytona, GitHub installation tokens, or the database. The app owns reviewer
sessions, webhook verification, target binding, the durable job queue, and the
delivery outbox.

TrueForge owns the agent run. BountyDesk starts a session, registers MCP tools,
and mirrors the run back into the case file. The agent can inspect the report,
call scope tools, probe the bound target, use skills, and draft a verdict. The
approval pause happens before `publish_verdict` can become an outbound comment.

The target runs in a sandbox. For the demo, Juice Shop is built ahead of time and
started from a Daytona snapshot. The target profile is resolved server-side, so
the report and the model cannot choose a different repository or target by
string.

<img src="https://raw.githubusercontent.com/Vaibhav91one/bountydesk/main/docs/screenshots/architecture-flow.png" alt="BountyDesk FigJam architecture flow from report intake to human-approved verdict">

*The FigJam flow maps the core path: intake, scope, sandbox investigation,
agent-drafted verdict, approval, and delivery.*

<img src="https://raw.githubusercontent.com/Vaibhav91one/bountydesk/main/docs/screenshots/open-intake-architecture.png" alt="BountyDesk FigJam open intake architecture from channels to pinned target and delivery">

*The open-intake version shows the product direction: different intake channels
normalize into one report object, then reproduction still goes through one
authorized target path.*

<img src="https://raw.githubusercontent.com/Vaibhav91one/bountydesk/main/docs/screenshots/auth-access-flow.png" alt="BountyDesk FigJam auth and access flow showing GitHub identity, reviewer allowlist, and session creation">

*Identity and authorization are separate. GitHub sign-in says who the reviewer
is. The allowlist and GitHub App installation decide what they can operate.*

The board is a planning reference. The text here is the current MVP claim:
GitHub issue intake is wired, email and file upload stay on the roadmap.

The data path is intentionally boring:

```text
GitHub App webhook
  -> Next.js API route
  -> Postgres durable job
  -> worker lease
  -> TrueForge session
  -> BountyDesk MCP tools
  -> Daytona target sandbox
  -> immutable verdict row
  -> approval decision
  -> delivery worker
  -> GitHub issue comment
```

Idempotency is based on the inbound delivery. Delivery safety is based on the
approved content hash. Repository authority is based on the GitHub App
installation and the server-held target profile.

## Tech stack

The stack is small on purpose.

<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/nextjs/nextjs-original.svg" alt="Next.js" width="42">
  &nbsp;
  <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/react/react-original.svg" alt="React" width="42">
  &nbsp;
  <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/typescript/typescript-original.svg" alt="TypeScript" width="42">
  &nbsp;
  <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/tailwindcss/tailwindcss-original.svg" alt="Tailwind CSS" width="42">
  &nbsp;
  <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/postgresql/postgresql-original.svg" alt="PostgreSQL" width="42">
  &nbsp;
  <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/supabase/supabase-original.svg" alt="Supabase" width="42">
  &nbsp;
  <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/github/github-original.svg" alt="GitHub" width="42">
  &nbsp;
  <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/docker/docker-original.svg" alt="Docker" width="42">
</p>

| Layer | What BountyDesk uses |
|---|---|
| App | Next.js App Router, React, TypeScript, npm |
| UI | Tailwind CSS, Base UI primitives, lucide/react icons, developer-icons |
| Database | Postgres on Supabase, Drizzle ORM, `drizzle-kit` migrations |
| Queue | Durable Postgres jobs table with leases and worker ticks |
| Agent runtime | TrueForge sessions, tools, skills, subagents, approvals |
| Tools | MCP endpoints for `publish_verdict` and scope-guard |
| Sandbox | Daytona for the hackathon target runtime |
| GitHub | GitHub App webhooks, installation lifecycle, short-lived installation tokens |
| Review | Qodo-reviewed pull requests, protected `main`, required build checks |

The important choice is Postgres as the queue. BountyDesk needs real row locks
and `SELECT ... FOR UPDATE SKIP LOCKED`, because a webhook handler should return
quickly while a worker owns the long-running investigation.

## The break this exists for

Security teams get a lot of reports that need the same first pass:

- Is this actually for a repository we own?
- Is the report in scope?
- Can the behavior be reproduced?
- Is there enough evidence for a useful response?
- Has a similar report already arrived?
- What should we say back to the reporter?

Most automation helps with one slice. It deduplicates reports, runs a scanner,
or sends a template. BountyDesk tries to make the whole loop coherent.

The core idea is that intake and reproduction are separate.

Today, a report arrives through GitHub issue intake. The domain model leaves
room for email and file upload later, but those channels are not wired for live
delivery yet. Intake can authenticate and store a report without needing to run
code. Reproduction is different. Reproduction requires a server-authorized
target profile. If a report has no bound target, the system refuses to claim
`REPRODUCED` or `NOT_REPRODUCED`, even if the agent tries to assert it.

That boundary is deliberate. The model is allowed to investigate. It is not
allowed to grant itself access.

<img src="https://raw.githubusercontent.com/Vaibhav91one/bountydesk/main/docs/screenshots/review-board.png" alt="BountyDesk review board with triaging, reproducing, and awaiting approval columns">

*The board shows the work by state: triaging, reproducing, and waiting on a
reviewer.*

## What TrueForge does in BountyDesk

TrueForge is the runtime that turns this from a prompt into an actual agent
workflow.

In BountyDesk, TrueForge gives the agent:

- A persisted session for the report.
- MCP tools for scope checks, target probes, and verdict drafting.
- A sandbox where the agent can run investigation steps.
- Skills that describe how to work with demo targets.
- Subagents for splitting up analysis.
- A native approval pause before irreversible output.

The approval gate is central to the design. The agent calls `publish_verdict`
with its drafted outcome, summary, and findings. The platform freezes that exact
payload and waits. If the reviewer approves, the same payload is delivered to
GitHub. If the reviewer denies, the verdict stays inside BountyDesk and nothing
is posted.

There is no mutable second copy of the outbound comment. The approved content
hash has to match the verdict payload at delivery time.

## The demo target

The current demo target is `Vaibhav91one/juice-shop`, pinned to commit
`1867b926c5f50e4e692dc9c8f61821413cebe0cd`, the `v17.3.0` tag.

The target is built ahead of time and run from an immutable Daytona snapshot.
That means the reproduction sandbox does not need to clone the repository or
install dependencies during the live run. It starts from a known target image and
the agent investigates the report from there.

<img src="https://raw.githubusercontent.com/Vaibhav91one/bountydesk/main/docs/screenshots/target-binding.png" alt="BountyDesk target binding diagram showing the connected repository, trusted controller, and Daytona target runtime">

*The repository, BountyDesk controller, and target runtime are separate on
purpose. The connected repo is source, not authority.*

That decision keeps the demo honest. The target is real, but the demo is not
betting on live dependency installs or network drift.

## The proof

**One real GitHub issue. One real Daytona sandbox run. One approved GitHub
comment. Zero duplicate comments on webhook replay.**

BountyDesk has already completed a real end-to-end proof against Juice Shop using
the earlier deterministic canary pipeline:

- A real GitHub issue was filed.
- The signed webhook was accepted.
- The durable worker created the session.
- The target ran in a real Daytona sandbox.
- The SQL injection scenario was reproduced.
- A human approved the exact outbound comment.
- BountyDesk posted a real GitHub issue comment.
- Replaying the same delivery did not create a duplicate report or duplicate
  comment.

That proof is important because it exercises the shape of the real system:
intake, queue, sandbox, approval, and delivery.

The newer agent-authored flow is now merged. In that flow, the TrueForge agent
investigates and drafts its own verdict instead of receiving a precomputed answer
from the server. That path is the right architecture, and it still needs its own
fresh live proof before I would call it fully demo-proven.

<img src="https://raw.githubusercontent.com/Vaibhav91one/bountydesk/main/docs/screenshots/reports-index.png" alt="BountyDesk reports index with search, filters, and report statuses">

*The reports index is the audit trail. The board can hide closed work, but the
index should hide nothing.*

## The safety model

BountyDesk is designed around a few hard rules.

The GitHub App is the source of repository access. OAuth login proves reviewer
identity. It does not grant repository scope. The app installation decides which
repositories the platform can receive reports for and comment on.

The server owns the target profile. The agent cannot pick a repository by name
from the report and use that as authority. Clone, deploy, probe, and delivery
all resolve through server-held state.

The sandbox status file only means target readiness. It can say the target
started and answered a health check. It cannot decide severity, reproduction, or
outbound content.

State-changing target calls are gated. Read probes are available to the agent,
but write probes go through an approval path.

No bound target means no reproduced verdict. The run can still produce analysis,
but the server will not accept a reproduced or not-reproduced claim without an
authorized target.

## What Qodo changed

Qodo was not a checkbox on this project. It found real bugs in the parts where
small mistakes would matter.

In the GitHub App intake path, it found race conditions around installation
lifecycle events and job enqueueing. Those fixes moved access checks and queue
insertion into the same transaction and added row locks and concurrency tests.

In the TrueForge approval path, it found deadline and cleanup bugs that could
leave harness state wrong after a timeout.

In the reproduction orchestrator, it found weak spots in the evidence path:
header handling, body hashing, readiness behavior, and cleanup.

In the verdict path, it found places where the older publish flow could blur the
line between the agent drafting a verdict and a reviewer executing one.

In the target profile work, it caught a more serious platform bug:
caller-selected target names could bind or rotate the wrong repository profile.
The fix now derives the repository-to-profile mapping server-side before target
state changes.

That review loop made the platform less impressive on paper and more reliable in
practice, which is the right trade.

## What is still not claimed

There are a few things I am intentionally not pretending are done.

Email and file upload intake are designed, but not wired for live delivery.

The fully automated arbitrary-repository build tier is designed, but not shipped.
Today, target compatibility can be handled with registered target profiles and
reviewed manifests.

DVWA, WebGoat, and CVE labs are useful practice targets, but they are not the
same thing as a report-shaped BountyDesk run unless they go through target
binding, approval, and delivery.

Daytona is the hackathon demo sandbox layer. The production version needs
stronger isolation for untrusted code, likely microVMs with host-side egress
denial.

## What I would build next

The next step is a fully dynamic repository path.

When a program connects a repository, BountyDesk should inspect it, propose a
target manifest, build it in a separate build sandbox with narrow dependency
egress, and move only a verified artifact into the reproduction sandbox. The
reproduction sandbox should have no external egress.

The important part is that the repository can suggest how it runs, but it cannot
authorize itself. The platform still has to own the target profile, commit pin,
artifact hash, approval gate, and delivery boundary.

That is the version that gets closest to the product I wanted: connect a repo,
receive a report, watch an agent investigate it live, and approve the exact
answer before the reporter sees it.

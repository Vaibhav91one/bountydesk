# Reviewer chat surface design

## Context

Approval chat currently mixes verdict reading, advisory metadata, and conversation in one dense pane. The header repeats Agent Bounty context, quick actions are generic, the send control shows its loading spinner beside the arrow, and newly arrived messages are not reliably brought into view. Provider replies also retain a procedural greeting and numbered menu that make chat feel scripted.

This change keeps reviewer chat durable and advisory while giving it a compact, human chat surface.

## Goals

- Make approval chat read like one focused conversation, not a debug panel.
- Keep verdict approval and advisory chat separate.
- Preserve durable message polling, retry identity, worker processing, and plain-text safety.
- Make new messages and provider responses easy to follow.
- Avoid fake client-side replies or claims of real token streaming.

## Design

### Approval pane header

The approval dialog's chat pane owns one header:

- Left: animated Back button using the existing `RollingIcon` and `ArrowLeft`.
- Center: Agent Bounty mascot and centered `Agent Bounty` label.
- Right: Info icon beside the existing dialog close button.

The existing dialog close button remains the only close control. The Info tooltip contains revision, content hash, and the advisory boundary: chat can discuss the draft but cannot change verdict, approval, target, or delivery state.

The chat body no longer repeats the mascot, report title, revision, hash, or advisory paragraph. The report title may appear in the centered greeting/context line only when useful.

### Conversation

The durable status endpoint remains source of truth. Reviewer and agent messages render as escaped plain text. Agent messages use the existing word-reveal component as presentation after the complete persisted body arrives. The reveal never invents content or simulates provider streaming.

While a reviewer message has no matching persisted agent response and its thread is open or running, show the existing grid loader and shimmer label. Error and cancelled threads keep the existing retry path.

The message list owns a ref and scrolls to its bottom when a new reviewer/agent message or pending state appears. The reveal completion also scrolls the list. The implementation must not scroll an outer dialog container.

### Composer

Use current durable form behavior:

- Input autofocuses when chat mounts.
- Clicking composer background focuses input.
- Submit sends trimmed text with the existing durable client request ID.
- Send control shows either spinner or arrow, never both.
- Sending remains active until the immediate status refresh completes, so the new reviewer message and pending state appear before the arrow returns.

### Reviewer actions

Replace current generic prompt labels with concise outline buttons, each using `RollingIcon` and a normal Phosphor icon:

- Summarize issue
- Review steps
- Suggest remediation
- Verify a fix
- Improve report

Each action sends a real durable reviewer message. No hardcoded response is added.

### Agent voice

Update the registered `bountydesk-chat` manifest and matching defense-in-depth context policy:

- Agent Bounty speaks as a warm, concise teammate.
- First response may greet and mention exact report title.
- Later responses do not repeat greeting or title unless needed.
- Replies use one to three short sentences, about 60 words or fewer.
- No headings, bullets, numbered menus, prompt restatement, or meta commentary unless reviewer requests detail.
- Existing no-tools, no-secrets, no-state-change, advisory-only constraints remain.

Because TrueForge sessions reuse their agent session ID, manifest changes require reapplying the agent and rotating or recreating existing chat provider sessions before validating new voice behavior. Existing durable messages remain history and are not rewritten.

## Boundaries

- No ChatComposer, LoadingState, or ThinkingState copy is ported as a fake scripted implementation.
- No new provider streaming protocol, partial-message schema, or server event stream is added.
- No approval, denial, verdict, target, or delivery behavior changes.
- No new UI dependency or Popover primitive. Reuse Tooltip, Button, RollingIcon, mascot, loader, and existing durable chat code.

## Verification

Automated:

- TypeScript check.
- ESLint on changed files.
- Existing chat helper, context, queue, worker, and report tests.
- Production build.
- Diff whitespace check.

Browser:

1. Open an approval-pending report.
2. Confirm centered Agent Bounty header, Back, Info tooltip, and one dialog close control.
3. Confirm verbose metadata is behind Info, not in main chat body.
4. Click each reviewer action and confirm a real durable reviewer message appears.
5. Confirm pending loader stays visible until the persisted agent response arrives.
6. Confirm the response reveals from persisted text and the list follows the newest content.
7. Confirm send spinner replaces arrow during submit.
8. Confirm Back returns to verdict and focus returns to Chat.
9. Confirm Escape closes dialog and approval/deny remain separate.
10. Confirm reduced-motion mode removes slide and reveal movement.

Deployment:

- Reapply the chat agent manifest in TrueForge.
- Restart the worker with reviewer chat enabled.
- Submit one production chat message, verify worker claim, and verify persisted AGENT response.

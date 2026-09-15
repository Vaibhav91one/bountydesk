# Reviewer chat surface implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make approval chat feel like a compact, human reviewer conversation with a centered Agent Bounty header, useful action pills, smooth message flow, and concise provider replies without replacing durable chat behavior.

**Architecture:** Keep `AgentChat` as the durable client for `/api/reports/[id]/chat` and `/chat/status`; the UI only presents persisted reviewer and agent rows. Keep approval navigation in `ApprovalDialog`, where the right pane owns the single chat header and the left pane remains the verdict/approval surface. Update the registered TrueForge chat manifest for voice, then reapply it before live verification because existing provider sessions retain their old manifest.

**Tech Stack:** Next.js App Router, React, TypeScript, Base UI Dialog/Tooltip, Phosphor icons, Tailwind classes, TrueForge named agent, Node test runner.

---

## File map

- Modify `app/(app)/reports/[id]/approval-dialog.tsx`: one centered Agent Bounty header for the chat pane, Back icon animation, Info tooltip beside the shared dialog close control, and no duplicate chat header.
- Modify `app/(app)/reports/[id]/agent-chat.tsx`: durable chat body, action pills, pending state, spinner/arrow state, smooth bottom scrolling, and streaming-reveal scroll callback.
- Modify `agent/bountydesk-chat.agent.json`: canonical system-level voice/output rules used by TrueForge.
- Modify `lib/reviewer-chat/context.test.ts`: lock manifest voice contract and title context.
- Modify `app/(app)/reports/agent-chat.test.ts`: lock the action-prompt contract and submit behavior constants.
- Use existing `components/rolling-icon.tsx`, `components/ui/button.tsx`, `components/ui/tooltip.tsx`, and `app/(app)/reports/[id]/agent-trace.tsx`; no new component library or dependency.
- Reapply `bountydesk-chat` through the existing TrueForge registration path after merge. Do not rewrite persisted chat history or fabricate provider replies.

## Task 1: Consolidate chat pane header

**Files:**
- Modify: `app/(app)/reports/[id]/approval-dialog.tsx:210-226`
- Modify: `app/(app)/reports/[id]/agent-chat.tsx:304-335`

- [ ] **Step 1: Remove duplicate body header**

Delete the `AgentChat` header block containing `AnimatedMascotSvg`, `Agent Bounty is on this case`, the report title line, and the tooltip. Keep `ADVISORY_LABEL` exported for the existing unit test, but do not render it as a second heading.

The `AgentChat` body should begin at its loading/error/ready state blocks. Remove now-unused `AnimatedMascotSvg`, `Tooltip`, `TooltipContent`, `TooltipTrigger`, and `reportTitle` imports/props.

- [ ] **Step 2: Make approval header the single visual header**

Replace the current chat-pane header with this structure. `DialogContent` already renders the only close X at `top-4 right-4`; `right-14` reserves its space.

```tsx
<div className="sticky top-0 z-10 grid grid-cols-[1fr_auto_1fr] items-center border-b border-border/50 bg-popover p-4 pr-24">
  <Button
    ref={chatBackRef}
    type="button"
    size="sm"
    variant="ghost"
    onClick={() => setChatting(false)}
    className="relative z-10 justify-self-start"
  >
    <RollingIcon icon={ArrowLeft} className="size-4" />
    Back
  </Button>

  <div className="flex items-center gap-2 text-body font-medium text-foreground">
    <AnimatedMascotSvg
      state="greeting"
      scope="approval-chat-header"
      className="size-9 [&>svg]:block [&>svg]:size-full"
    />
    <h2>Agent Bounty</h2>
  </div>

  <Tooltip>
    <TooltipTrigger
      render={
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="About advisory chat"
          className="absolute top-4 right-14"
        />
      }
    >
      <Info className="size-4" />
    </TooltipTrigger>
    <TooltipContent side="bottom">
      Agent Bounty can discuss this report but cannot change its verdict or approval.
    </TooltipContent>
  </Tooltip>
</div>
```

Add imports for `AnimatedMascotSvg`, `Info`, `RollingIcon`, `Tooltip`, `TooltipContent`, and `TooltipTrigger`. Keep the existing dialog close control and the left-pane `DialogTitle` for dialog accessibility. Do not add a second close button.

- [ ] **Step 3: Run focused type/lint checks**

Run:

```bash
npx tsc --noEmit
npx eslint --max-warnings=0 'app/(app)/reports/[id]/approval-dialog.tsx' 'app/(app)/reports/[id]/agent-chat.tsx'
```

Expected: no errors or warnings.

- [ ] **Step 4: Commit**

```bash
git add 'app/(app)/reports/[id]/approval-dialog.tsx' 'app/(app)/reports/[id]/agent-chat.tsx'
git commit -m "Consolidate reviewer chat header"
```

## Task 2: Make action pills and composer motion consistent

**Files:**
- Modify: `app/(app)/reports/[id]/agent-chat.tsx:43-47,364-399`
- Test: `app/(app)/reports/agent-chat.test.ts`

- [ ] **Step 1: Define reviewer actions as typed data**

Replace the two generic prompts with five explicit actions. Keep prompt text durable and direct:

```tsx
export const QUICK_PROMPTS = [
  { label: "Summarize issue", icon: ListChecks, prompt: "Summarize the reproduced issue, including steps and impact." },
  { label: "Review steps", icon: MagnifyingGlass, prompt: "Review the reproduction steps and point out any missing details for triage." },
  { label: "Suggest remediation", icon: Wrench, prompt: "Suggest remediation and secure coding guidance for this issue." },
  { label: "Verify a fix", icon: ShieldCheck, prompt: "Suggest verification steps for a reviewer to confirm a fix." },
  { label: "Improve report", icon: PencilSimple, prompt: "Suggest concise edits to the report text for clarity." },
] as const;
```

Use Phosphor `ShieldCheck` and `PencilSimple` for the two actions not currently imported. Keep `Button variant="outline"`, and use `RollingIcon` rather than raw icon nodes:

```tsx
{QUICK_PROMPTS.map(({ label, icon: Icon, prompt }) => (
  <Button
    key={label}
    size="xs"
    variant="outline"
    onClick={() => sendPrompt(prompt)}
    disabled={Boolean(sending)}
  >
    <RollingIcon icon={Icon} className="size-3.5" />
    {label}
  </Button>
))}
```

- [ ] **Step 2: Keep spinner and arrow mutually exclusive**

The shared `Button` prepends its spinner while preserving children. Render the arrow only when no request is sending:

```tsx
<Button
  type="submit"
  size="icon-sm"
  variant="default"
  aria-label="Send advisory message"
  disabled={!canSend}
  loading={Boolean(sending)}
  className="size-8 rounded-md"
>
  {sending ? null : <ArrowUp weight="bold" className="size-4" />}
</Button>
```

- [ ] **Step 3: Keep send state through status refresh**

In `submit`, do not clear `sending` before `loadStatus`. This prevents the arrow from returning before the durable reviewer row and pending state have reached the message list:

```tsx
setFailed(null);
setSendError(null);
onReasonChange(request.body);
await loadStatus();
setSending(null);
```

Keep the existing catch path, which clears `sending`, stores the failed request, and preserves retry identity.

- [ ] **Step 4: Update pure UI contract test**

In `app/(app)/reports/agent-chat.test.ts`, assert the new label list and existing submission contract:

```tsx
assert.deepEqual(
  QUICK_PROMPTS.map(({ label }) => label),
  ["Summarize issue", "Review steps", "Suggest remediation", "Verify a fix", "Improve report"],
);
```

Import `QUICK_PROMPTS` alongside existing helpers. Keep tests for `canSubmitReviewerMessage`, `reviewerMessagePayload`, and `responseRequestId`.

- [ ] **Step 5: Run focused test/lint**

```bash
node --env-file-if-exists=.env.local --import tsx --test 'app/(app)/reports/agent-chat.test.ts'
npx eslint --max-warnings=0 'app/(app)/reports/[id]/agent-chat.tsx' 'app/(app)/reports/agent-chat.test.ts'
```

Expected: all tests pass and no lint warnings.

- [ ] **Step 6: Commit**

```bash
git add 'app/(app)/reports/[id]/agent-chat.tsx' 'app/(app)/reports/agent-chat.test.ts'
git commit -m "Polish reviewer chat actions"
```

## Task 3: Smooth latest-message behavior

**Files:**
- Modify: `app/(app)/reports/[id]/agent-chat.tsx:169-233,338-362`

- [ ] **Step 1: Add a dedicated message-list scroll helper**

Use the inner chat list, not the outer approval pane, so message updates do not move the verdict panel:

```tsx
const messagesRef = useRef<HTMLDivElement>(null);
const scrollMessages = useCallback((behavior: ScrollBehavior = "smooth") => {
  const list = messagesRef.current;
  if (list) list.scrollTo({ top: list.scrollHeight, behavior });
}, []);
```

Attach `ref={messagesRef}` to the existing `max-h-64 min-h-28 overflow-y-auto` message list.

- [ ] **Step 2: Scroll after durable updates and reveal completion**

After `messages`, `pendingMessage`, and `mode` are computed, use:

```tsx
useEffect(() => {
  if (mode === "ready") scrollMessages(messages.length <= 1 ? "auto" : "smooth");
}, [mode, messages.length, pendingMessage?.clientRequestId, scrollMessages]);
```

Pass `onDone={scrollMessages}` only to the newest persisted agent message. Do not repeatedly scroll old messages when the list is already readable:

```tsx
const newestAgentId = [...messages].reverse().find((message) => message.sender === "AGENT")?.id;
```

For the newest agent row:

```tsx
<StreamingText text={message.body} onDone={message.id === newestAgentId ? scrollMessages : undefined} />
```

If manual scroll preservation is needed after browser verification, only follow when the list is within 48px of its bottom; do not yank a reviewer away from older text they are reading.

- [ ] **Step 3: Run type/build checks**

```bash
npx tsc --noEmit
npm run build
```

Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add 'app/(app)/reports/[id]/agent-chat.tsx'
git commit -m "Keep reviewer chat on latest message"
```

## Task 4: Tighten Agent Bounty voice and context tests

**Files:**
- Modify: `agent/bountydesk-chat.agent.json`
- Modify: `lib/reviewer-chat/context.test.ts`
- Reference: `lib/reviewer-chat/context.ts`, `lib/reviewer-chat/worker.ts`, `lib/reviewer-chat/schema.ts`

- [ ] **Step 1: Replace soft manifest wording with an explicit output contract**

Set the manifest instruction string to include these requirements before the existing safety rules:

```text
Plain text only. Reply in 1 to 3 short sentences, maximum 60 words. No headings, bullets, numbered lists, markdown, prompt restatement, or meta commentary. Answer the reviewer directly. Use a warm, lightly playful Agent Bounty voice that sounds natural and human, not corporate or theatrical. On the first turn only, begin with a brief greeting and include the exact report title in quotation marks. On later turns, do not greet or repeat the title unless needed.
```

Keep the existing untrusted-data, no-tools, no-secrets, no-state-change, and advisory-only rules. Keep `Avoid em dashes`.

- [ ] **Step 2: Keep the user-level policy aligned**

Update `REVIEWER_CHAT_SYSTEM_POLICY` in `lib/reviewer-chat/context.ts` with the concise response contract as defense in depth. The manifest remains the actual system-level instruction; this policy remains part of the untrusted user message and must not be treated as a security boundary by itself.

- [ ] **Step 3: Lock wording and title context in tests**

In `lib/reviewer-chat/context.test.ts`, assert:

```tsx
assert.match(chatAgentDefinition.manifest.instructions, /1 to 3 short sentences/);
assert.match(chatAgentDefinition.manifest.instructions, /first turn only/);
assert.match(buildReviewerChatContext({
  title: "SQL injection in login form",
  reportBody: "body",
  summary: "summary",
  findings: [],
}), /Report title/);
```

Keep the existing no-tools/no-sandbox/no-approval assertions.

- [ ] **Step 4: Reapply TrueForge manifest**

After the code is merged, deploy/restart TrueForge bootstrap or run the existing authenticated command:

```bash
npm run agent:apply
```

Existing provider sessions retain old agent instructions. Preserve durable messages, but rotate/recreate reviewer-chat provider sessions before validating a new first response. Do not rewrite persisted old messages.

- [ ] **Step 5: Run context tests**

```bash
node --env-file-if-exists=.env.local --import tsx --test lib/reviewer-chat/context.test.ts
```

Expected: all context/manifest tests pass.

- [ ] **Step 6: Commit**

```bash
git add agent/bountydesk-chat.agent.json lib/reviewer-chat/context.ts lib/reviewer-chat/context.test.ts
 git commit -m "Tighten Agent Bounty reviewer voice"
```

## Task 5: Full verification and deployment

**Files:**
- All files changed in Tasks 1 through 4.

- [ ] **Step 1: Run full checks**

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: all tests pass, lint/build succeed, and no whitespace errors.

- [ ] **Step 2: Self-review the diff**

Confirm these facts in the diff:

- Agent Bounty header appears once in chat pane.
- Info tooltip sits beside the shared Dialog close control.
- Back and every action pill use `RollingIcon`.
- Spinner and arrow are mutually exclusive.
- Message scroll is attached to the inner message list.
- Durable API/polling/retry contracts are unchanged.
- Manifest voice rules are present and no fake replies were added.

- [ ] **Step 3: Commit any final self-review fixes**

```bash
git add 'app/(app)/reports/[id]/approval-dialog.tsx' 'app/(app)/reports/[id]/agent-chat.tsx' agent/bountydesk-chat.agent.json lib/reviewer-chat/context.ts lib/reviewer-chat/context.test.ts app/'(app)'/reports/agent-chat.test.ts
git commit -m "Address reviewer chat self-review"
```

- [ ] **Step 4: Open PR and wait for checks**

```bash
git push -u origin fix/reviewer-chat-surface
gh pr create --base main --head fix/reviewer-chat-surface
 gh pr checks <number> --watch
```

Expected: `build`, Vercel preview, and other required checks pass.

- [ ] **Step 5: Merge and deploy**

```bash
gh pr merge <number> --squash --delete-branch
gh run list --branch main --limit 1
```

Reapply the TrueForge agent manifest and restart the reviewer-chat worker after deployment. No schema migration is required.

- [ ] **Step 6: Chrome DevTools smoke test**

Against an approval-pending production report:

1. Open approval dialog.
2. Verify one centered Agent Bounty header, one Back control, one Info tooltip, and one shared close X.
3. Verify main chat body has no duplicate advisory metadata section.
4. Verify each action pill has visible icon motion on hover and submits its exact action text.
5. Type a message. Confirm input is focused on pane entry.
6. Confirm send button shows spinner without arrow during request, then arrow returns only after status refresh.
7. Confirm reviewer row appears immediately after refresh and agent response appears from durable status.
8. Confirm chat list smoothly follows newest content, including reveal completion.
9. Verify Back, Escape, approval, and denial remain functional.
10. Verify reduced-motion mode removes pane/reveal movement.

## Commit sequence

Suggested commits:

```text
Consolidate reviewer chat header
Polish reviewer chat actions
Keep reviewer chat on latest message
Tighten Agent Bounty reviewer voice
```

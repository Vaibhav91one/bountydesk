# Approval dialog and reviewer chat polish

## Context

The approval dialog now works: the verdict pane scrolls, the chat slides in beside it, suggestions and the composer stay pinned, and Agent Bounty answers as a teammate. What remains is roughness around the edges. The dialog can grow unbounded on tall content, verdict text and actions scroll away together, approve and re-check sit in unrelated places, chat loading hugs the top-left, the composer carries an extra wrapper, the info control is oversized, and the Agent Bounty sender label repeats on every message.

This spec fixes that surface without touching the approval gate, the durable chat protocol, or the agent voice.

## Goals

- Keep the reviewer in one bounded dialog from reading through signing.
- Make long verdicts readable without losing the actions.
- Make approve and re-check read as one decision with two weights.
- Make chat feel calm: smooth slide, centered loading, sticky footer, quiet labels.
- Preserve every safety invariant: human gate, hash check, advisory-only chat, plain text.

## Design

### Bounded full-height dialog

The dialog keeps `h-[85vh]` with `max-h-[85vh]` and `overflow-hidden`. Nothing inside it may grow the dialog itself. Both panes stay `min-h-0` so inner scroll regions, not the dialog, absorb overflow. This matters because verdict payloads vary from a paragraph to pages, and the dialog must hold its shape either way.

### Scrollable verdict content

The verdict pane splits into three zones: a fixed header, a scrollable content region holding the verdict card, and a pinned action footer. Today the card and its buttons scroll together, so a reviewer who reads to the bottom loses the context of what they approve, and one who acts early may not have read at all. Pinning the actions keeps the decision visible while the evidence scrolls.

### Pinned actions

The footer holds Approve, Deny, and Chat controls in one row, with the acting and disabled states threaded through as today. The verdict card keeps its summary, findings, evidence meter, and detail drawer, but no longer owns the final buttons. The dialog owns them, because signing is the dialog's job and the card's job is showing what is signed.

### Split approve and ask to re-check menu

Approve stays a single primary click, since the comment is right there to read. Ask to re-check moves out of the suggestion pill row and into a split-button menu beside Approve, with a confirm step that states the consequence: the current verdict is superseded and the fresh run needs its own approval. Recheck stays where it is today in behavior (server-validated guidance, history preserved), only its placement changes, so reviewers see the two paths side by side and pick deliberately.

### Smooth chat slide and centered loading

The pane track keeps the two-up slide with the existing cubic-bezier ease and a matching `motion-reduce` fallback that removes the transition. The loading state centers in the chat pane with the spinner and label as one centered status, rather than hugging the top-left, because a whole-pane state should read as the pane's content, not a stray row.

### Sticky suggestions and composer without outer wrapper

The suggestion pills and the composer form one sticky footer at the chat pane bottom. The extra outer wrapper around them goes away so sticky positioning binds to the pane, not to a nested box that can scroll off. The pills keep horizontal scroll for narrow widths. The composer keeps its rounded pill shape, autofocus, trimmed submit, durable request ID, and spinner-or-arrow send control.

### Compact info popover

The header info control shrinks to the same compact icon-button size as the close button beside it, with the existing tooltip text: chat can discuss the draft but cannot change verdict, approval, target, or delivery state. The dialog close button remains the only close control.

### Sender label

Only the repeated Agent Bounty sender label above each agent message is removed. The chat pane header keeps its mascot and Agent Bounty title, and the thinking indicator keeps its label, since those identify the surface and the state, not each row. Reviewer bubbles keep their shape so authorship stays clear without a label on every agent row.

## Accessibility and reduced motion

- Both panes keep `aria-hidden` and `inert` mirroring so screen readers and keyboards only reach the visible pane.
- The message list keeps `role="log"` with `aria-live="polite"`.
- Loading uses `role="status"`, errors use `role="alert"`, and the send button keeps its accessible label.
- Focus moves into the composer when chat opens and returns to the Chat control when it closes. Escape closes the dialog.
- The slide, message reveal, and send transitions all honor `motion-reduce`.

## Tests and file ownership

Ownership stays where it is: dialog layout in `approval-dialog.tsx`, message helpers and chat state in `agent-chat.tsx`, composer and pills in `prompt-bar.tsx`, verdict presentation in `verdict-card.tsx`.

Cover with unit tests for the pure helpers (`canSubmitReviewerMessage`, `shouldFollowChat`, `isFreshAgentMessage`, `responseRequestId`) and the pinned-footer and split-button rendering, plus the existing chat helper, context, queue, worker, and report suites. Verify in the browser: long verdicts scroll under pinned actions, approve stays one click, re-check confirms before superseding, loading centers, the footer sticks, info stays compact, and reduced motion removes movement. Run the TypeScript check, ESLint on changed files, and a production build.

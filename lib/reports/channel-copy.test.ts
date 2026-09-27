import assert from "node:assert/strict";
import test from "node:test";

import {
  approveConsequence,
  channelLabel,
  deliverableNoun,
  deliveredLabel,
  destinationPhrase,
  draftPrompt,
  draftRecordLabel,
  draftViewerSubtitle,
} from "./channel-copy";

/**
 * The point of these is the email channel. Every string here was written for GitHub and shipped
 * unchanged onto a working email path, where it told a reviewer their reply would be posted to an
 * issue. What a reviewer is signing has to match what actually goes out.
 */

const EMAIL_FACING = [draftPrompt, draftRecordLabel, approveConsequence, draftViewerSubtitle];

test("no approval string tells an email reviewer their verdict goes to an issue", () => {
  for (const copy of EMAIL_FACING) {
    const text = copy("email");
    assert.doesNotMatch(text, /issue/i, `"${text}" mentions an issue on the email channel`);
    assert.doesNotMatch(text, /comment/i, `"${text}" calls an email reply a comment`);
  }
});

test("the GitHub wording is unchanged, because that path was already right", () => {
  assert.equal(draftPrompt("github"), "Post this comment to the issue?");
  assert.equal(draftRecordLabel("github"), "The comment on record");
  assert.match(approveConsequence("github"), /posts the drafted comment to the issue/);
  assert.match(draftViewerSubtitle("github"), /as it will read on the issue/);
  assert.equal(deliveredLabel("github"), "Comment delivered");
});

test("an email verdict is described as a reply to the reporter", () => {
  assert.equal(deliverableNoun("email"), "reply");
  assert.equal(destinationPhrase("email"), "to the reporter");
  assert.match(approveConsequence("email"), /emails the drafted reply to the reporter/);
  assert.equal(deliveredLabel("email"), "Reply delivered");
});

test("an upload verdict reads as an email reply, never an issue comment", () => {
  // Upload rides the email transport, so its approval copy must match email, not fall back to the
  // GitHub default.
  for (const copy of EMAIL_FACING) {
    const text = copy("upload");
    assert.doesNotMatch(text, /issue/i, `"${text}" mentions an issue on the upload channel`);
    assert.doesNotMatch(text, /comment/i, `"${text}" calls an upload reply a comment`);
  }
  assert.equal(deliverableNoun("upload"), "reply");
  assert.equal(destinationPhrase("upload"), "to the reporter");
  assert.match(approveConsequence("upload"), /emails the drafted reply to the reporter/);
  assert.equal(deliveredLabel("upload"), "Reply delivered");
  assert.equal(channelLabel("upload"), "Upload");
});

test("every approve consequence still says the action cannot be undone", () => {
  // The warning is the reason the sentence exists; a channel variant must not drop it.
  for (const channel of ["github", "email", "manual", "something-new"]) {
    assert.match(approveConsequence(channel), /cannot be undone/);
  }
});

test("an unknown channel reads vaguely rather than wrongly", () => {
  // manual has no delivery path today, and a channel added later must not claim to post an issue
  // comment just because github was the default.
  for (const channel of ["manual", "drive", ""]) {
    assert.doesNotMatch(destinationPhrase(channel), /issue/i);
  }
  assert.equal(channelLabel("drive"), "drive");
});

test("the intake fact names a channel rather than printing its enum value", () => {
  assert.equal(channelLabel("github"), "GitHub issue");
  assert.equal(channelLabel("email"), "Email");
  assert.equal(channelLabel("manual"), "Manual");
});

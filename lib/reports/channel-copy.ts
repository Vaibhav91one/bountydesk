/**
 * What an approved verdict turns into, in the reviewer's words.
 *
 * A verdict lands as a comment on a GitHub issue or as a reply to the address the report was sent
 * from, and the approval surfaces have to say which. Until email delivery shipped, every string was
 * written for GitHub, so a reviewer signing an email verdict was told it would be posted to an
 * issue. These live together rather than inline at each call site because there are six of them and
 * they drifted apart once already.
 *
 * Unknown channels fall back to neutral wording. `manual` has no delivery path today, and a channel
 * added later should read vaguely rather than read wrong.
 */

export type ReportChannel = "github" | "email" | "manual" | "upload" | "advisory" | (string & {});

/**
 * Whether the verdict is mailed as a reply to the reporter rather than posted as an issue comment.
 * Upload rides the email transport, so it reads exactly like email everywhere the copy branches: a
 * reviewer signing an upload verdict is emailing the reporter, not commenting on an issue.
 */
function deliversAsEmailReply(channel: ReportChannel): boolean {
  return channel === "email" || channel === "upload";
}

/**
 * Whether the verdict is written back by editing a GitHub security advisory. Advisories have no
 * comments API, so an advisory verdict is neither a comment nor a reply: it replaces the advisory's
 * text, and the copy says so rather than borrowing the issue wording.
 */
function deliversAsAdvisory(channel: ReportChannel): boolean {
  return channel === "advisory";
}

/** The thing itself: "comment" on an issue, "reply" to a reporter. Lowercase, for mid-sentence. */
export function deliverableNoun(channel: ReportChannel): string {
  if (deliversAsAdvisory(channel)) return "advisory update";
  return deliversAsEmailReply(channel) ? "reply" : "comment";
}

/** Where it goes. Reads after a verb: "posts the drafted comment {to the issue}". */
export function destinationPhrase(channel: ReportChannel): string {
  if (deliversAsAdvisory(channel)) return "to the advisory";
  return channel === "github" ? "to the issue" : "to the reporter";
}

/** The question over the drafted text, in approve mode. */
export function draftPrompt(channel: ReportChannel): string {
  if (deliversAsAdvisory(channel)) return "Write this verdict to the advisory?";
  return deliversAsEmailReply(channel)
    ? "Send this reply to the reporter?"
    : "Post this comment to the issue?";
}

/** The same text once a decision exists, where it is a record rather than a question. */
export function draftRecordLabel(channel: ReportChannel): string {
  if (deliversAsAdvisory(channel)) return "The advisory text on record";
  return deliversAsEmailReply(channel) ? "The reply on record" : "The comment on record";
}

/** The sentence under "Approve this verdict?". Ends the caller's paragraph. */
export function approveConsequence(channel: ReportChannel): string {
  if (deliversAsAdvisory(channel)) {
    return "This writes the drafted verdict to the repository's security advisory as the agent's verdict. This action cannot be undone.";
  }
  return deliversAsEmailReply(channel)
    ? "This emails the drafted reply to the reporter as the agent's verdict. This action cannot be undone."
    : "This posts the drafted comment to the issue as the agent's verdict. This action cannot be undone.";
}

/** How the full text reads in the viewer dialog's subtitle. */
export function draftViewerSubtitle(channel: ReportChannel): string {
  if (deliversAsAdvisory(channel)) {
    return "The full verdict as it will read on the advisory, drafted by Agent Bounty.";
  }
  return deliversAsEmailReply(channel)
    ? "The full reply as the reporter will receive it, drafted by Agent Bounty."
    : "The full comment as it will read on the issue, drafted by Agent Bounty.";
}

/** The queue card's line for a delivered report. */
export function deliveredLabel(channel: ReportChannel): string {
  if (deliversAsAdvisory(channel)) return "Advisory updated";
  return deliversAsEmailReply(channel) ? "Reply delivered" : "Comment delivered";
}

/** How the intake channel is named in the case file's facts. */
export function channelLabel(channel: ReportChannel): string {
  switch (channel) {
    case "github":
      return "GitHub issue";
    case "email":
      return "Email";
    case "manual":
      return "Manual";
    case "upload":
      return "Upload";
    case "advisory":
      return "GitHub advisory";
    default:
      return channel;
  }
}

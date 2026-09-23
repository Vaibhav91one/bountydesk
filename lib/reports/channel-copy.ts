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

export type ReportChannel = "github" | "email" | "manual" | (string & {});

/** The thing itself: "comment" on an issue, "reply" to a reporter. Lowercase, for mid-sentence. */
export function deliverableNoun(channel: ReportChannel): string {
  return channel === "email" ? "reply" : "comment";
}

/** Where it goes. Reads after a verb: "posts the drafted comment {to the issue}". */
export function destinationPhrase(channel: ReportChannel): string {
  switch (channel) {
    case "github":
      return "to the issue";
    case "email":
      return "to the reporter";
    default:
      return "to the reporter";
  }
}

/** The question over the drafted text, in approve mode. */
export function draftPrompt(channel: ReportChannel): string {
  return channel === "email"
    ? "Send this reply to the reporter?"
    : "Post this comment to the issue?";
}

/** The same text once a decision exists, where it is a record rather than a question. */
export function draftRecordLabel(channel: ReportChannel): string {
  return channel === "email" ? "The reply on record" : "The comment on record";
}

/** The sentence under "Approve this verdict?". Ends the caller's paragraph. */
export function approveConsequence(channel: ReportChannel): string {
  return channel === "email"
    ? "This emails the drafted reply to the reporter as the agent's verdict. This action cannot be undone."
    : "This posts the drafted comment to the issue as the agent's verdict. This action cannot be undone.";
}

/** How the full text reads in the viewer dialog's subtitle. */
export function draftViewerSubtitle(channel: ReportChannel): string {
  return channel === "email"
    ? "The full reply as the reporter will receive it, drafted by Agent Bounty."
    : "The full comment as it will read on the issue, drafted by Agent Bounty.";
}

/** The queue card's line for a delivered report. */
export function deliveredLabel(channel: ReportChannel): string {
  return channel === "email" ? "Reply delivered" : "Comment delivered";
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
    default:
      return channel;
  }
}

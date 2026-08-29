/**
 * What each integration is, independent of whether anything is connected to it.
 *
 * Shared by the list and the detail page so the two cannot describe the same channel
 * differently. Everything here is sourced: the permissions are the ones the App requests, the
 * events are the four the webhook route actually handles, and the links go to pages that
 * exist. Nothing is filled in to make a panel look complete.
 */

export type IntegrationIcon = "github" | "gmail" | "onedrive" | "folder";

export type IntegrationLink = { label: string; href: string; external?: boolean };

export type Integration = {
  id: string;
  name: string;
  /** One line, the way the list shows it. */
  tagline: string;
  icon: IntegrationIcon;
  /** Whoever wrote the integration. BountyDesk's own App, for the one that exists. */
  developer: string;
  built: boolean;
  /**
   * The badge, for a channel that is not built. Designed and not built is not the same as not
   * planned, and one label for both would make the page contradict its own overview.
   */
  status?: string;
  /** Long-form, rendered as headed sections on the detail page. */
  sections: { title: string; body?: string; bullets?: string[] }[];
  links: IntegrationLink[];
};

const GITHUB_DOCS = "https://docs.github.com/en/apps/overview";
const SOURCE = "https://github.com/Vaibhav91one/bountydesk";

export const INTEGRATIONS: Integration[] = [
  {
    id: "github",
    name: "GitHub",
    tagline: "Report intake from issues, and the approved verdict posted back as a comment.",
    icon: "github",
    developer: "BountyDesk",
    built: true,
    sections: [
      {
        title: "Overview",
        body: "A signed issue webhook creates a report, and an approved verdict is delivered back to that issue as a comment. Signing in with GitHub says who you are; installing the App is what grants access to a repository, and the two are deliberately separate.",
      },
      {
        title: "Permissions requested",
        bullets: [
          "Metadata, read. Repository name, visibility and archive state, which is how a renamed or archived repository stops being admissible.",
          "Issues, read and write. Read to accept a report, write to post the comment a reviewer approved.",
        ],
      },
      {
        title: "Permissions deliberately not requested",
        bullets: [
          "Contents, read. Needed only to clone a private repository. Without it a private repository's issue is still accepted and triaged, and reproduction refuses.",
          "Nothing that can write code, open pull requests, or change repository settings.",
        ],
      },
      {
        title: "Events this app acts on",
        bullets: [
          "issues. Creates a report, once per delivery id.",
          "installation. A suspended or deleted installation stops intake and delivery at once.",
          "installation_repositories. Adding or removing a repository from the grant.",
          "repository. Rename, transfer, archive.",
        ],
      },
      {
        title: "What it never does",
        body: "Nothing is posted without a human approving the exact text. The delivery worker reads the immutable verdict and refuses any payload whose content hash differs from the approved one, so an approval cannot be reused for different words.",
      },
    ],
    links: [
      { label: "Documentation", href: GITHUB_DOCS, external: true },
      { label: "Source", href: SOURCE, external: true },
      { label: "Terms", href: "/terms" },
      { label: "Privacy policy", href: "/privacy" },
    ],
  },
  {
    id: "email",
    name: "Email",
    tagline: "Report intake by email, with no GitHub connection needed.",
    icon: "gmail",
    developer: "BountyDesk",
    built: false,
    status: "Designed, not built",
    sections: [
      {
        title: "Overview",
        body: "A report arrives as an email and is triaged without any GitHub connection. Intake and reproduction are separate: a report with no bound target profile stops at analysis only, whichever channel it came in through.",
      },
      {
        title: "Why it is not built",
        body: "Outbound needs a verified recipient identity and a transport receipt before a delivery attempt may be recorded. Until those exist, a report from this channel must never reach DELIVERED, so the channel is designed rather than half-shipped.",
      },
      {
        title: "What the design already fixes",
        bullets: [
          "Bodies and attachments are parsed in a disposable sandbox with no network and no secrets.",
          "Sender identity is never target authorisation. Only a server-held target profile is.",
        ],
      },
    ],
    links: [{ label: "Design record", href: SOURCE, external: true }],
  },
  {
    id: "upload",
    name: "File upload",
    tagline: "Report intake by direct upload, for a reporter with no account anywhere.",
    icon: "folder",
    developer: "BountyDesk",
    built: false,
    status: "Designed, not built",
    sections: [
      {
        title: "Overview",
        body: "A report is uploaded directly, for a reporter with neither a GitHub account nor an email thread. Like every other channel, it can create and triage a report and cannot reproduce one without a server-authorised target.",
      },
      {
        title: "Why it is not built",
        body: "The same outbound gap as email: no verified recipient, no transport receipt, so no delivery.",
      },
    ],
    links: [{ label: "Design record", href: SOURCE, external: true }],
  },
  {
    id: "drive",
    name: "Drive",
    tagline: "Pulling reports from a shared drive folder.",
    icon: "onedrive",
    developer: "BountyDesk",
    built: false,
    status: "Not planned",
    sections: [
      {
        title: "Overview",
        body: "Pulling reports from a shared drive folder. It is on the channel map in the design file and is not in scope for this version, which is a different thing from designed and not built.",
      },
    ],
    links: [],
  },
];

export function findIntegration(id: string): Integration | undefined {
  return INTEGRATIONS.find((integration) => integration.id === id);
}

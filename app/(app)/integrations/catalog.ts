/**
 * What each integration is, independent of whether anything is connected to it.
 *
 * Shared by the list and the detail page so the two cannot describe the same channel
 * differently. Everything here is sourced: the permissions are the ones the App requests, the
 * events are the five the webhook route actually handles, and the links go to pages that
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
          "Repository security advisories, read and write. For a report reproduced against this repository, a reviewer can open a private draft advisory so the owner can track the fix without it being public, and update it when a revised verdict is delivered.",
          "Contents, read, for private repositories only. It is what lets a private repository be cloned, with a token scoped to that one repository and revoked after the clone. An installation that does not grant it still has its private repositories' reports accepted and triaged, and reproduction refuses. A public repository clones without it.",
        ],
      },
      {
        title: "Permissions deliberately not requested",
        bullets: [
          "Nothing that can write code, open pull requests, or change repository settings.",
        ],
      },
      {
        title: "Events this app acts on",
        bullets: [
          "issues. Creates a report, once per delivery id.",
          "repository_advisory. A privately reported or published advisory creates a report held for a reviewer, and the approved verdict is written back into the advisory.",
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
    tagline: "Report intake by email, and the approved verdict mailed back, with no GitHub connection needed.",
    icon: "gmail",
    developer: "BountyDesk",
    built: true,
    sections: [
      {
        title: "Overview",
        body: "A report arrives as an email and is triaged without any GitHub connection. Intake and reproduction are separate: a report with no bound target profile stops at analysis only, whichever channel it came in through.",
      },
      {
        title: "The verdict reply",
        body: "An approved verdict is mailed back to the reporter. The recipient is an allowlisted address, or an outside sender whose mail passed SPF and DKIM aligned with its From domain, and that is checked again at send time. Provider acceptance is not a receipt: the report reaches DELIVERED only when the provider reports the mail delivered. A report bound to a connected repository with a live grant is delivered as a draft security advisory on that repository instead.",
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
    built: true,
    sections: [
      {
        title: "Overview",
        body: "Anyone can submit a report on the public page at /submit, with an email contact and, optionally, target material: a source tarball with a Dockerfile at its root, a single Dockerfile, or a prebuilt image named with its sha256 digest. The report waits at the gate until a reviewer decides, so nothing is built, started or analysed before then.",
      },
      {
        title: "Delivery",
        body: "The uploader confirms the contact address with a six-digit code sent to it. The verdict rides the email transport to that address only after the code is confirmed and a reviewer approves the exact text; an unconfirmed contact is refused at approval and again at send time.",
      },
      {
        title: "Target material",
        bullets: [
          "Built only when a reviewer approves it and states the port, readiness path and start command. The scope is loopback only and never comes from the upload.",
          "Built in the egress-limited build sandbox and bound as a pinned target, anchored on the archive digest or the image digest.",
          "A prebuilt image is accepted only from an allowed registry, Docker Hub and GHCR unless PREBUILT_IMAGE_REGISTRIES says otherwise.",
          "A build that fails leaves the report unbound, so it runs analysis only.",
        ],
      },
      {
        title: "Limits",
        body: "Uploads are capped at about 4 MB and use the same daily limits per contact and per domain as outside email, plus a limit per client address.",
      },
    ],
    links: [
      { label: "Submit page", href: "/submit" },
      { label: "Design record", href: SOURCE, external: true },
    ],
  },
  {
    id: "drive",
    name: "Drive",
    tagline: "Pulling reports from a shared drive folder.",
    icon: "onedrive",
    developer: "BountyDesk",
    built: false,
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

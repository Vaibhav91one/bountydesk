import type { listConnections } from "@/lib/github/connections";

import type { IntegrationRow } from "./integration-list";

/**
 * One row per platform, never per installation or per repository. Shared by the page and the
 * mobile API so both describe the same three integrations the same way.
 */
export function integrationRows(
  connections: Awaited<ReturnType<typeof listConnections>>,
): IntegrationRow[] {
  const live = connections.filter((connection) => !connection.suspendedAt);
  const repositories = live.flatMap((connection) => connection.repositories);
  const admissible = repositories.filter((repo) => repo.status === "admissible");
  const suspended = connections.length > 0 && live.length === 0;

  function githubDetail(): string {
    if (connections.length === 0) {
      return "Report intake from GitHub issues. Installing the App is what grants repository access; signing in only says who you are.";
    }
    if (suspended) {
      return "Every installation is suspended, so nothing under them is accepted.";
    }
    // Both numbers, because they answer different questions: how much the App can see, and how
    // much of that is configured well enough to accept a report.
    return `Connected. ${repositories.length} repositor${repositories.length === 1 ? "y" : "ies"} granted, ${admissible.length} accepting reports.`;
  }

  return [
    {
      id: "github",
      name: "GitHub",
      detail: githubDetail(),
      icon: "github",
      installed: connections.length > 0,
      action: { kind: "link", href: "/integrations/github", label: "View" },
    },
    {
      id: "email",
      name: "Email",
      // Intake and delivery are both live: an approved verdict is emailed back to the verified sender.
      detail: "Report intake by email, and the approved verdict is emailed back.",
      icon: "gmail",
      installed: true,
      action: { kind: "link", href: "/integrations/email", label: "View" },
    },
    {
      id: "upload",
      name: "File upload",
      detail: "Report intake by public upload, with optional target material to build.",
      icon: "folder",
      installed: true,
      action: { kind: "link", href: "/integrations/upload", label: "View" },
    },
  ];
}

import { GitHubLight } from "developer-icons";

import { RollingIcon } from "@/components/rolling-icon";
import { Button } from "@/components/ui/button";
import { requireReviewer } from "@/lib/auth/dal";
import { installUrl } from "@/lib/auth/oauth";
import { listConnections } from "@/lib/github/connections";

import { IntegrationList, type IntegrationRow } from "./integration-list";

export const metadata = { title: "Integrations · BountyDesk" };

/**
 * One row per platform, never per installation or per repository.
 *
 * This screen answers "what can BountyDesk talk to", which has four answers however many
 * accounts are connected. Listing every installation and every repository here turned one
 * connected account into three rows that all said GitHub, and buried the three channels that
 * are not GitHub underneath them.
 *
 * Which repositories are admissible, and what each is bound to, is the Connections screen.
 */
export default async function IntegrationsPage() {
  const session = await requireReviewer();
  const connections = await listConnections();

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

  const rows: IntegrationRow[] = [
    {
      id: "github",
      name: "GitHub",
      detail: githubDetail(),
      icon: "github",
      installed: connections.length > 0,
      action:
        connections.length > 0
          ? { kind: "link", href: "/connections", label: "Manage" }
          : { kind: "link", href: installUrl(), label: "Install" },
    },
    {
      id: "email",
      name: "Email",
      detail: "Report intake by email. Designed, not built.",
      icon: "gmail",
      installed: false,
      action: { kind: "none", label: "Unavailable" },
    },
    {
      id: "upload",
      name: "File upload",
      detail: "Report intake by upload. Designed, not built.",
      icon: "folder",
      installed: false,
      action: { kind: "none", label: "Unavailable" },
    },
    {
      id: "drive",
      name: "Drive",
      detail: "Not planned for this version.",
      icon: "onedrive",
      installed: false,
      action: { kind: "none", label: "Unavailable" },
    },
  ];

  return (
    <main className="flex flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border/50 px-8 py-7">
        <div className="flex flex-col gap-1">
          <h1 className="text-title text-foreground">Integrations</h1>
          <p className="text-meta text-muted-foreground">
            Where reports come from. Signed in as {session.login}.
          </p>
        </div>
        <Button size="sm" nativeButton={false} render={<a href={installUrl()} />}>
          <RollingIcon icon={GitHubLight} className="size-4" />
          {connections.length === 0 ? "Install BountyDesk" : "Add installation"}
        </Button>
      </header>

      <div className="p-8">
        <IntegrationList rows={rows} />
      </div>
    </main>
  );
}

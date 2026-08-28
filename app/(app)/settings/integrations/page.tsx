import { GitHubLight } from "developer-icons";

import { RollingIcon } from "@/components/rolling-icon";
import { Button } from "@/components/ui/button";
import { requireReviewer } from "@/lib/auth/dal";
import { installUrl } from "@/lib/auth/oauth";
import {
  listConnections,
  manageRepositoriesUrl,
  type RepoStatus,
} from "@/lib/github/connections";

import { IntegrationList, type IntegrationRow } from "./integration-list";

export const metadata = { title: "Integrations · BountyDesk" };

/** What each status means to the person reading it, not what it means to the database. */
const STATUS: Record<RepoStatus, string> = {
  admissible: "Connected. Reports opened here are accepted.",
  "not-configured": "No reproduction target is bound, so reports are refused.",
  archived: "Archived on GitHub. Intake stays closed until it is unarchived.",
  disconnected: "The installation no longer grants this repository.",
  suspended: "The installation is suspended, so nothing under it is accepted.",
};

/**
 * The channels that have a design but no route yet, and one that is not in the product at all.
 *
 * They are listed so the page says what exists rather than implying GitHub is the only thing
 * anyone ever considered. Their button is disabled because nothing is behind it.
 */
const UNBUILT: IntegrationRow[] = [
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

export default async function IntegrationsPage() {
  const session = await requireReviewer();
  const connections = await listConnections();

  const rows: IntegrationRow[] = [];
  for (const connection of connections) {
    const managementUrl = manageRepositoriesUrl(connection.installationId, {
      login: connection.accountLogin,
      type: connection.accountType,
    });

    rows.push({
      id: `installation-${connection.installationRowId}`,
      name: connection.accountLogin,
      detail: connection.suspendedAt
        ? "GitHub App suspended. Nothing under it is accepted."
        : `GitHub App · ${connection.grantedRepositoryCount} repositor${connection.grantedRepositoryCount === 1 ? "y" : "ies"} · Issues read and write, Metadata read`,
      icon: "github",
      installed: true,
      // GitHub owns which repositories the App can see, so Manage leaves for GitHub. A
      // connection made before account-type tracking has no such link, and re-selecting the
      // account on GitHub is what restores it.
      action: managementUrl
        ? { kind: "link", href: managementUrl, label: "Manage" }
        : { kind: "link", href: installUrl(), label: "Repair" },
    });

    for (const repo of connection.repositories) {
      rows.push({
        id: `repo-${repo.connectedRepositoryId}`,
        name: repo.fullName,
        detail: `${STATUS[repo.status]} Target: ${repo.targetProfileName ?? "none bound"}.`,
        icon: "github",
        installed: true,
        action: { kind: "configure", repoId: repo.repoId, configured: repo.targetProfileName !== null },
      });
    }
  }
  rows.push(...UNBUILT);

  return (
    <main className="flex flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b px-8 py-7">
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

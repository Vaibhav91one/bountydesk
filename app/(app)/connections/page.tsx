import { requireReviewer } from "@/lib/auth/dal";
import { installUrl } from "@/lib/auth/oauth";
import { listConnections, type RepoStatus } from "@/lib/github/connections";

import { ConnectionTabs, type RepositoryRow } from "./connection-tabs";

export const metadata = { title: "Connections · BountyDesk" };

/** What each status means to the person reading it, not what it means to the database. */
const STATUS: Record<RepoStatus, { label: string; hint: string }> = {
  admissible: { label: "Connected", hint: "Reports opened here are accepted." },
  "not-configured": {
    label: "Not configured",
    hint: "Granted by the installation, but no reproduction target is bound, so reports are refused.",
  },
  archived: {
    label: "Archived",
    hint: "Archived on GitHub. Intake stays closed until it is unarchived.",
  },
  disconnected: {
    label: "Disconnected",
    hint: "The installation no longer grants this repository.",
  },
  suspended: {
    label: "Suspended",
    hint: "The whole installation is suspended, so nothing under it is accepted.",
  },
};

export default async function ConnectionsPage() {
  await requireReviewer();
  const connections = await listConnections();

  const repositories: RepositoryRow[] = connections.flatMap((connection) =>
    connection.repositories.map((repo) => {
      const status = STATUS[repo.status];
      return {
        id: `repo-${repo.connectedRepositoryId}`,
        account: connection.accountLogin,
        status: repo.status,
        fullName: repo.fullName,
        label: status.label,
        hint: status.hint,
        target: repo.targetProfileName,
        repoId: repo.repoId,
        configured: repo.targetProfileName !== null,
        connected: repo.status === "admissible",
      };
    }),
  );

  return (
    <main className="flex flex-1 flex-col">
      <header className="flex flex-col gap-1 border-b border-border/50 px-8 py-7">
        <h1 className="text-title text-foreground">Connections</h1>
        <p className="text-meta text-muted-foreground">
          Every place a report can come from, and what each one is doing right now.
        </p>
      </header>

      <div className="p-8">
        <ConnectionTabs repositories={repositories} installUrl={installUrl()} />
      </div>
    </main>
  );
}

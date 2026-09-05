import { requireReviewer } from "@/lib/auth/dal";
import { installUrl } from "@/lib/auth/oauth";
import {
  listConnections,
  manageRepositoriesUrl,
  type RepoStatus,
} from "@/lib/github/connections";

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
      // "owner/name" is GitHub's own shape and the only name this row has, so the two halves
      // are split here rather than in the browser, where a name without a slash would leave
      // the panel showing an empty field.
      const [owner, name] = repo.fullName.split("/");
      return {
        id: `repo-${repo.connectedRepositoryId}`,
        account: connection.accountLogin,
        status: repo.status,
        fullName: repo.fullName,
        owner: owner ?? connection.accountLogin,
        name: name ?? repo.fullName,
        label: status.label,
        hint: status.hint,
        target: repo.targetProfileName,
        repoId: repo.repoId,
        configured: repo.targetProfileName !== null,
        connected: repo.status === "admissible",
        reportCount: repo.reports.total,
        awaitingReview: repo.reports.awaitingReview,
        delivered: repo.reports.delivered,
        lastReportAt: repo.reports.lastReportAt?.toISOString() ?? null,
        lastSyncedAt: connection.lastSyncedAt.toISOString(),
        // Null for an installation recorded before the account type was, which has no safe
        // deep link: the personal and organization settings paths are different pages.
        manageUrl: manageRepositoriesUrl(connection.installationId, {
          login: connection.accountLogin,
          type: connection.accountType,
        }),
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

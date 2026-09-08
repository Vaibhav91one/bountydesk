import { listConnections, manageRepositoriesUrl, type RepoStatus } from "@/lib/github/connections";

import type { RepositoryRow } from "./connection-tabs";

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

/**
 * The connections read model flattened into the rows the table renders, dates ISO-stringified so the
 * shape crosses from a server component or a JSON route into the client one unchanged. Shared by the
 * page's first paint and the /api/connections poll, so both produce identical rows.
 */
export async function connectionRows(): Promise<RepositoryRow[]> {
  const connections = await listConnections();
  return connections.flatMap((connection) =>
    connection.repositories.map((repo) => {
      const status = STATUS[repo.status];
      // "owner/name" is GitHub's own shape and the only name this row has, so the two halves are split
      // here rather than in the browser, where a name without a slash would leave a field empty.
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
        manageUrl: manageRepositoriesUrl(connection.installationId, {
          login: connection.accountLogin,
          type: connection.accountType,
        }),
        onboarding: repo.onboarding,
        onboardingProgress: repo.onboardingProgress,
        onboardingDetail: repo.onboardingDetail,
      };
    }),
  );
}

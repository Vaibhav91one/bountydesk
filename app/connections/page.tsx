import { requireReviewer } from "@/lib/auth/dal";
import { installUrl } from "@/lib/auth/oauth";
import { connectedRepository, db, eq, githubInstallation } from "@/lib/db";

export default async function ConnectionsPage() {
  const session = await requireReviewer();

  const rows = await db
    .select({
      account: githubInstallation.accountLogin,
      suspendedAt: githubInstallation.suspendedAt,
      deletedAt: githubInstallation.deletedAt,
      repo: connectedRepository.fullName,
      active: connectedRepository.active,
    })
    .from(githubInstallation)
    .leftJoin(
      connectedRepository,
      eq(connectedRepository.installationId, githubInstallation.id),
    )
    .orderBy(githubInstallation.accountLogin, connectedRepository.fullName);

  const live = rows.filter((r) => !r.deletedAt);

  return (
    <main>
      <h1>Connections</h1>
      <p>Signed in as {session.login}.</p>

      {live.length === 0 ? (
        <p>
          No repositories are connected yet. Install the BountyDesk App and choose which
          repositories it may read issues from.
        </p>
      ) : (
        <ul>
          {live.map((row, index) => (
            <li key={`${row.account}-${row.repo ?? index}`}>
              {row.account}
              {row.repo ? ` / ${row.repo}` : " (no repositories selected)"}
              {row.suspendedAt ? " (suspended)" : null}
              {row.repo && !row.active ? " (disconnected)" : null}
            </li>
          ))}
        </ul>
      )}

      <a href={installUrl()}>
        {live.length === 0 ? "Install BountyDesk" : "Change repository access"}
      </a>

      <p>
        Repository access comes from the App installation, not from your login. Suspending or
        uninstalling it stops intake and delivery straight away.
      </p>

      <form action="/api/auth/logout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}

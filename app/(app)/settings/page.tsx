import { requireReviewer } from "@/lib/auth/dal";
import { readAttempts, readDecisions, readScope } from "@/lib/settings/read";

import { SettingsTabs } from "./settings-tabs";

export const metadata = { title: "Settings · BountyDesk" };

/**
 * One settings screen, three tabs.
 *
 * Scope and Audit had a sidebar entry each and no route behind either, which is three ways to
 * find out that nothing is there. They are one page now, and each tab reads the tables that
 * actually exist rather than showing a placeholder.
 *
 * Integrations and Connections are deliberately not here. They are what a person sets up on
 * their first day, not something they go looking for under settings.
 */
export default async function SettingsPage() {
  const session = await requireReviewer();
  const [profiles, decisions, attempts] = await Promise.all([
    readScope(),
    readDecisions(),
    readAttempts(),
  ]);

  return (
    <main className="flex flex-1 flex-col">
      <header className="flex flex-col gap-1 border-b border-border/50 px-8 py-7">
        <h1 className="text-title text-foreground">Settings</h1>
        <p className="text-meta text-muted-foreground">
          What the guard enforces, what has been signed, and who you are signed in as.
        </p>
      </header>

      <div className="p-8">
        <SettingsTabs
          profiles={profiles}
          decisions={decisions.map((row) => ({ ...row, decidedAt: row.decidedAt.toISOString() }))}
          attempts={attempts.map((row) => ({
            ...row,
            finishedAt: row.finishedAt.toISOString(),
          }))}
          login={session.login}
          userId={session.userId}
        />
      </div>
    </main>
  );
}

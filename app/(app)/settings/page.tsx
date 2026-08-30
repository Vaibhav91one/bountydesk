import Link from "next/link";
import { ArrowUpRight } from "@phosphor-icons/react/ssr";

import { Button } from "@/components/ui/button";
import { requireReviewer } from "@/lib/auth/dal";
import { readSettings } from "@/lib/settings/read";

import { Panel } from "./panel";
import { SettingsTabs } from "./settings-tabs";

export const metadata = { title: "Settings · BountyDesk" };

/**
 * One settings screen, three tabs.
 *
 * Scope and Audit had a sidebar entry each and no route behind either, which is three ways to
 * find out that nothing is there. They are one page now, and each tab reads the tables that
 * actually exist rather than showing a placeholder.
 *
 * The harness is a fourth thing and it sits on its own route. Every tab here reads BountyDesk's
 * own tables and always renders; /settings/harness reads a separate service over the network and
 * has to survive that service being unreachable, so the audit trail does not queue behind it.
 *
 * Integrations and Connections are deliberately not here. They are what a person sets up on
 * their first day, not something they go looking for under settings.
 */
export default async function SettingsPage() {
  const session = await requireReviewer();
  const { profiles, decisions, attempts } = await readSettings();

  return (
    <main className="flex flex-1 flex-col">
      <header className="flex flex-col gap-1 border-b border-border/50 px-8 py-7">
        <h1 className="text-title text-foreground">Settings</h1>
        <p className="text-meta text-muted-foreground">
          What the guard enforces, what has been signed, and who you are signed in as.
        </p>
      </header>

      <div className="flex flex-col gap-6 p-8">
        <Panel
          title="Agent harness"
          detail="The model providers, connectors, skills, sandbox provider and saved agent the TrueForge instance behind this console is configured with."
          aside={
            <Button variant="outline" size="sm" render={<Link href="/settings/harness" />}>
              Open
              <ArrowUpRight />
            </Button>
          }
        >
          <p className="text-body text-muted-foreground">
            A fresh harness needs a model provider and a sandbox provider registered before the
            saved agent will apply, so that is set here rather than in the harness&apos;s own UI.
          </p>
        </Panel>

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

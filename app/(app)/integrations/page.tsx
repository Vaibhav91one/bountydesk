import { GitHubLight } from "developer-icons";

import { RollingIcon } from "@/components/rolling-icon";
import { Button } from "@/components/ui/button";
import { requireReviewer } from "@/lib/auth/dal";
import { installUrl } from "@/lib/auth/oauth";
import { listConnections } from "@/lib/github/connections";

import { IntegrationList } from "./integration-list";
import { integrationRows } from "./rows";

export const metadata = { title: "Integrations · BountyDesk" };

/**
 * One row per platform, never per installation or per repository.
 *
 * This screen answers "what can BountyDesk talk to", which has three answers however many
 * accounts are connected. Listing every installation and every repository here turned one
 * connected account into three rows that all said GitHub, and buried the channels that are
 * not GitHub underneath them.
 *
 * Which repositories are admissible, and what each is bound to, is the Connections screen.
 */
export default async function IntegrationsPage() {
  const session = await requireReviewer();
  const connections = await listConnections();

  const rows = integrationRows(connections);

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

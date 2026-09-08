import { requireReviewer } from "@/lib/auth/dal";
import { installUrl } from "@/lib/auth/oauth";

import { ConnectionsLive } from "./connections-live";
import { connectionRows } from "./rows";

export const metadata = { title: "Connections · BountyDesk" };

export default async function ConnectionsPage() {
  await requireReviewer();
  const repositories = await connectionRows();

  return (
    <main className="flex flex-1 flex-col">
      <header className="flex flex-col gap-1 border-b border-border/50 px-8 py-7">
        <h1 className="text-title text-foreground">Connections</h1>
        <p className="text-meta text-muted-foreground">
          Every place a report can come from, and what each one is doing right now.
        </p>
      </header>

      <div className="p-8">
        <ConnectionsLive initial={repositories} installUrl={installUrl()} />
      </div>
    </main>
  );
}

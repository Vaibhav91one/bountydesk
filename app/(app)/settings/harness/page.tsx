import { requireReviewer } from "@/lib/auth/dal";
import { readHarness } from "@/lib/trueforge/harness";

import { HarnessTabs } from "./harness-tabs";

export const metadata = { title: "Agent harness · BountyDesk" };

/**
 * The TrueForge harness: the five things it holds, on one screen.
 *
 * Skills, connectors and the agent had scripts; model providers and the sandbox provider had
 * nothing, so `npm run agent:apply` against a fresh harness fails with "Unknown model
 * openai/gpt-5-mini, provider not configured" and there was no way to fix that from here.
 *
 * Its own route rather than a sixth tab on /settings, because this is the one settings surface
 * reading a separate service over the network. `readHarness` never throws: each section carries
 * its own error, so a harness that is down shows five explanations instead of a blank page, and
 * the audit trail next door is not waiting on five round trips to paint.
 */
export default async function HarnessSettingsPage() {
  await requireReviewer();
  const snapshot = await readHarness();

  return (
    <main className="flex flex-1 flex-col">
      <header className="flex flex-col gap-1 border-b border-border/50 px-8 py-7">
        <h1 className="text-title text-foreground">Agent harness</h1>
        <p className="text-meta text-muted-foreground">
          What the TrueForge instance behind this console is configured with, and what
          BountyDesk registers on it.
        </p>
      </header>

      <div className="p-8">
        <HarnessTabs snapshot={snapshot} />
      </div>
    </main>
  );
}

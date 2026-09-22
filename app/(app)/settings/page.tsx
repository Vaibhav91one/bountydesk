import { requireReviewer } from "@/lib/auth/dal";
import { canManageReviewers, listReviewers } from "@/lib/auth/reviewers";
import { readHarness } from "@/lib/trueforge/harness";

import { HarnessTabs } from "./harness-tabs";

export const metadata = { title: "Settings · BountyDesk" };

/**
 * Settings is the TrueForge harness: the five things it holds, on one screen.
 *
 * A fresh harness needs a model provider and a sandbox provider before `npm run agent:apply`
 * will take the saved manifest, which pins `openai/gpt-5-mini` and enables the sandbox. Both
 * are set here, so the harness can be brought up without leaving this app.
 *
 * `readHarness` never throws: each section carries its own error, so a harness that is down
 * shows five explanations instead of a blank page.
 */
export default async function SettingsPage() {
  const session = await requireReviewer();
  const [snapshot, reviewers] = await Promise.all([readHarness(), listReviewers()]);
  const canManage = canManageReviewers(session.email);

  return (
    <main className="flex flex-1 flex-col">
      <header className="flex flex-col gap-1 border-b border-border/50 px-8 py-7">
        <h1 className="text-title text-foreground">Settings</h1>
        <p className="text-meta text-muted-foreground">
          Who may operate BountyDesk, and what the TrueForge instance behind this console is
          configured with.
        </p>
      </header>

      <div className="flex flex-col gap-6 p-8">
        <HarnessTabs snapshot={snapshot} reviewers={reviewers} canManageReviewers={canManage} />
      </div>
    </main>
  );
}

import { requireReviewer } from "@/lib/auth/dal";

import { ReviewerUploadForm } from "./reviewer-upload-form";

export const metadata = { title: "Submit a target · BountyDesk" };

/**
 * A reviewer uploads a target straight from the dashboard, instead of going through the public
 * /submit page. The public page is OTP-gated because anyone can post to it; a reviewer is already
 * authenticated, so this page skips that and hands the material straight to the build.
 */
export default async function ReviewerUploadPage() {
  await requireReviewer();

  return (
    <main className="flex flex-1 flex-col">
      <header className="flex flex-col gap-1 border-b border-border/50 px-8 py-7">
        <h1 className="text-title text-foreground">Submit a target</h1>
        <p className="text-meta text-muted-foreground">
          Upload target material and the settings to run it. It is built in the offline sandbox and
          bound to a new report; the drafted verdict still needs your approval before anything is
          delivered.
        </p>
      </header>
      <div className="max-w-2xl px-8 py-7">
        <ReviewerUploadForm />
      </div>
    </main>
  );
}

import { AllowButton, DenyButton } from "./decision-buttons";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireReviewer } from "@/lib/auth/dal";
import { agentSession, and, db, eq, isNotNull, report, verdict } from "@/lib/db";

export default async function ReviewPage() {
  const session = await requireReviewer();

  // Both conditions should coincide by construction (the poller sets them together), but
  // neither is trusted alone: a report stuck in AWAITING_APPROVAL with no pending call is not
  // this queue's business, and a pending call on a report that somehow left AWAITING_APPROVAL
  // is not either.
  const pending = await db
    .select({
      reportId: report.id,
      title: report.title,
      sourceRef: report.sourceRef,
      channel: report.channel,
      payload: verdict.payload,
      contentHash: verdict.contentHash,
    })
    .from(report)
    .innerJoin(agentSession, eq(agentSession.reportId, report.id))
    .innerJoin(verdict, eq(verdict.id, agentSession.pendingVerdictId))
    .where(and(eq(report.state, "AWAITING_APPROVAL"), isNotNull(agentSession.pendingThreadId)))
    .orderBy(report.createdAt);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Review queue</h1>
        <p className="text-sm text-muted-foreground">
          Signed in as {session.login}. This is a bridge to TrueForge&apos;s own approval gate,
          not a replacement for it: Allow only records a decision and queues it for submission;
          it never posts anything itself.
        </p>
      </header>

      {pending.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is waiting on a decision.</p>
      ) : null}

      {pending.map((row) => (
        <Card key={row.reportId}>
          <CardHeader>
            <CardTitle className="text-base">{row.title}</CardTitle>
            <p className="text-xs text-muted-foreground">
              {row.channel} · {row.sourceRef}
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* The exact bytes that would be posted to GitHub. Plain text, never HTML: a
                reviewer has to see what would actually go out, not a rendering of it. */}
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted p-3 text-sm">
              {row.payload}
            </pre>
            <p className="text-xs text-muted-foreground">
              content hash <code className="font-mono">{row.contentHash}</code>
            </p>
            <div className="flex flex-wrap gap-4">
              <AllowButton reportId={row.reportId} />
              <DenyButton reportId={row.reportId} />
            </div>
          </CardContent>
        </Card>
      ))}
    </main>
  );
}

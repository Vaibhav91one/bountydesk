"use client";

import { Warning } from "@phosphor-icons/react/ssr";

import { Button } from "@/components/ui/button";

/**
 * What a reviewer sees when the queue cannot be read.
 *
 * The error itself is not shown. It comes from a database query and can carry table names,
 * column names and fragments of the statement, none of which help the person reading and all
 * of which are worth not putting on a screen. The digest is what a developer needs to find
 * the real one in the server log.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-border/50 px-8 py-7">
        <h1 className="text-title text-foreground">Review queue</h1>
      </header>

      <div className="p-8">
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-8"
        >
          <span className="flex items-center gap-2.5 text-heading text-destructive">
            <Warning className="size-5" />
            The queue could not be loaded
          </span>
          <p className="max-w-2xl text-body text-muted-foreground">
            Nothing was changed. Reports and their verdicts are unaffected; this screen only
            reads them.
          </p>
          {error.digest ? (
            <p className="text-meta text-muted-foreground">
              Reference <code className="font-mono">{error.digest}</code>
            </p>
          ) : null}
          <Button size="sm" variant="outline" onClick={reset}>
            Try again
          </Button>
        </div>
      </div>
    </main>
  );
}

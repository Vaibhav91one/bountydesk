import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * A report id that matches nothing.
 *
 * Says only that, and offers the queue. Whether the id is malformed, belongs to another
 * install or was never real is not a distinction worth drawing for the person reading, and
 * drawing it would answer questions about what exists to anyone who asks.
 */
export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-start gap-4 p-8">
      <h1 className="text-title text-foreground">No such report</h1>
      <p className="max-w-2xl text-body text-muted-foreground">
        Nothing here matches that id. It may have been removed, or the link may be wrong.
      </p>
      <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/board" />}>
        Back to the review queue
      </Button>
    </main>
  );
}

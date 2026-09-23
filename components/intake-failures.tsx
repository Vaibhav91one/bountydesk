"use client";

import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { IntakeJobView } from "@/lib/intake/jobs-read";
import { fetchLive } from "@/lib/reports/status-query";

/**
 * Intake deliveries that gave up, as one badge beside the queue's count.
 *
 * Pending and running deliveries used to have their own strip above the board, which appeared
 * and vanished as mail arrived and moved the board with it. Only a failure needs a reviewer: a
 * delivery that dead-lettered before it became a report has no card to show it on. The badge
 * sits inline in the header, so the board never moves.
 *
 * Every string rendered is server-derived and shown as a text node, never HTML, so worker prose
 * in a dead-letter reason stays inert. Titles and bodies never reach this component: the API
 * only sends the payload-free view.
 */
function lineFor(job: IntakeJobView): string {
  const subject = job.label ?? "intake";
  const cause = job.reason ? `, ${job.reason}` : "";
  const tries =
    Number.isFinite(job.attempts) && Number.isFinite(job.maxAttempts) && job.attempts > 0
      ? ` after ${job.attempts} attempts`
      : "";
  return `${subject}${cause}${tries}`;
}

export function IntakeFailures({ refetchInterval }: { refetchInterval: number | false }) {
  // A failed poll shows nothing rather than erroring the board. Intake visibility is advisory
  // next to the queue; losing it must not take the reports with it.
  const { data } = useQuery({
    queryKey: ["intake-jobs"],
    queryFn: () => fetchLive<{ jobs: IntakeJobView[] }>("/api/intake/jobs"),
    refetchInterval,
  });

  const failed = (data?.jobs ?? []).filter((job) => job.state === "DEAD_LETTER");
  if (failed.length === 0) return null;

  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="destructive" />}>
        {failed.length} intake failed
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex-col items-start">
        {failed.map((job) => (
          <span key={job.id} title={`delivery ${job.deliveryPrefix}`} className="break-words">
            {lineFor(job)}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

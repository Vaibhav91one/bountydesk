"use client";

import { useQuery } from "@tanstack/react-query";

import type { IntakeJobView } from "@/lib/intake/jobs-read";
import { fetchLive } from "@/lib/reports/status-query";

/**
 * The intake strip: queued, running and failed webhook deliveries above the board.
 *
 * Everything rendered here is a server-derived string shown as a text node, never HTML,
 * so worker prose in a dead-letter reason stays inert. Titles and bodies from GitHub
 * never reach this component: the API only sends the payload-free view.
 */
function subjectFor(job: IntakeJobView): string {
  return job.label ?? `delivery ${job.deliveryPrefix}`;
}

function ageFor(job: IntakeJobView): string {
  return job.ageLabel === "now" ? "just now" : `${job.ageLabel} ago`;
}

function lineFor(job: IntakeJobView): string {
  if (job.state === "DEAD_LETTER") {
    // The delivery id lives in the title for support, so the visible line stays readable.
    const subject = job.label ?? "intake";
    const cause = job.reason ? `, ${job.reason}` : "";
    const tries =
      Number.isFinite(job.attempts) &&
      Number.isFinite(job.maxAttempts) &&
      job.attempts > 0
        ? ` after ${job.attempts} attempts`
        : "";
    return `Intake failed: ${subject}${cause}${tries}`;
  }
  const verb = job.state === "SESSION_CREATED" || job.state === "RUNNING" ? "running" : "pending";
  return `Intake ${verb}: ${subjectFor(job)}, received ${ageFor(job)}`;
}

export function IntakeStrip({ refetchInterval }: { refetchInterval: number | false }) {
  // A failed poll hides the strip rather than erroring the board. Intake visibility is
  // advisory next to the queue; losing it must not take the reports with it.
  const { data } = useQuery({
    queryKey: ["intake-jobs"],
    queryFn: () => fetchLive<{ jobs: IntakeJobView[] }>("/api/intake/jobs"),
    refetchInterval,
  });

  const jobs = data?.jobs ?? [];
  if (jobs.length === 0) return null;

  return (
    <section aria-label="Intake" className="border-b border-border/50 px-8 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-heading text-foreground">Intake</h2>
        <p className="text-body text-muted-foreground">
          An issue starts a run only when its body has a /reproduce line from an allowed
          reviewer.
        </p>
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {jobs.map((job) => (
          <li
            key={job.id}
            title={`delivery ${job.deliveryPrefix}`}
            className={
              job.state === "DEAD_LETTER"
                ? "text-body text-destructive min-w-0 break-words"
                : "text-body text-muted-foreground min-w-0 break-words"
            }
          >
            {lineFor(job)}
          </li>
        ))}
      </ul>
    </section>
  );
}

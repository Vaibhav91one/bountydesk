import { StepBadge } from "../reports/[id]/lifecycle-step";
import { cn } from "@/lib/utils";
import { onboardingView } from "./onboarding-steps";

/** The connections analogue of the report lifecycle: the onboarding ladder laid out horizontally,
 *  reusing the lifecycle StepBadge so a step reads the same in both places. */
export function OnboardingStepper({ state }: { state: string | null }) {
  const { steps, terminal } = onboardingView(state);

  return (
    <div className="flex flex-col gap-4">
      {terminal === "unsupported" ? (
        <p className="rounded-md bg-muted px-3 py-2 text-meta text-muted-foreground">
          This repository cannot be onboarded as a reproduction target. Its reports go the analysis-only route.
        </p>
      ) : null}
      {terminal === "failed" ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-meta text-destructive">
          Onboarding stopped after using up its retry attempts. Reconnecting the repository or pushing a
          corrected commit starts it again from the top.
        </p>
      ) : null}

      <ol className="flex items-start">
        {steps.map((step, i) => {
          const leftLit = i > 0 && steps[i - 1].state === "done";
          const rightLit = step.state === "done";
          return (
            <li key={step.key} className="flex flex-1 flex-col items-center gap-2 text-center">
              <div className="flex w-full items-center">
                <span className={cn("h-0.5 flex-1", i === 0 ? "opacity-0" : leftLit ? "bg-phase-delivered" : "bg-border")} />
                <StepBadge state={step.state} index={i + 1} />
                <span
                  className={cn("h-0.5 flex-1", i === steps.length - 1 ? "opacity-0" : rightLit ? "bg-phase-delivered" : "bg-border")}
                />
              </div>
              <div className="flex flex-col gap-0.5 px-1">
                <span
                  className={cn(
                    "text-meta font-medium",
                    step.state === "pending" || step.state === "skipped" ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {step.label}
                </span>
                <span className="text-[11px] leading-tight text-muted-foreground">{step.note}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

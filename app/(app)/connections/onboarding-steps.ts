import type { OnboardingState } from "@/lib/build-onboarding/queue";
import type { StepState } from "@/lib/reports/case-view";

/**
 * The onboarding ladder as a horizontal stepper, mirroring the report lifecycle
 * (lib/reports/case-view.ts). The current onboarding state (targetProfile row's `state`, surfaced on
 * the connections row as onboardingDetail.state) places the cursor: earlier steps are done, the cursor
 * step is current, later steps pending. CONFIGURED is all done; UNSUPPORTED and FAILED are terminal
 * branches where the ladder stopped after the plan step. Pure, so it is unit-tested without a DB.
 */
export type OnboardingStepView = { key: string; label: string; note: string; state: StepState };

export type OnboardingView = {
  steps: OnboardingStepView[];
  /** A terminal outcome the stepper shows as a banner; null while onboarding is in flight. */
  terminal: "configured" | "unsupported" | "failed" | null;
};

const STEPS: ReadonlyArray<{ key: string; label: string; note: string }> = [
  { key: "plan", label: "Plan", note: "Classify the repo and review whether it can be sandboxed" },
  { key: "build", label: "Build", note: "Build the target image(s) in a sandbox and register a snapshot" },
  { key: "manifest", label: "Manifest", note: "Derive the target manifest from the plan" },
  { key: "approval", label: "Approval", note: "A reviewer approves the proposed target" },
  { key: "verify", label: "Verify", note: "Boot the snapshot offline and prove it is what it claims" },
  { key: "configured", label: "Configured", note: "The reproduction target is written and bound" },
];

/** Which step index each in-flight state sits on. APPROVED sits on Verify: the offline verify and the
 *  profile write happen once a reviewer has approved. */
const CURSOR: Partial<Record<OnboardingState, number>> = {
  PENDING_PLAN: 0,
  PENDING_BUILD: 1,
  PENDING_MANIFEST: 2,
  AWAITING_APPROVAL: 3,
  APPROVED: 4,
};

export function onboardingView(state: OnboardingState | string | null | undefined): OnboardingView {
  const at = (s: StepState) => STEPS.map((step) => ({ ...step, state: s }));

  if (!state) return { steps: at("pending"), terminal: null };
  if (state === "CONFIGURED") return { steps: at("done"), terminal: "configured" };
  if (state === "UNSUPPORTED" || state === "FAILED") {
    // The ladder stopped after the plan step: plan ran, everything after it was not reached.
    return {
      steps: STEPS.map((step, i) => ({ ...step, state: (i === 0 ? "done" : "skipped") as StepState })),
      terminal: state === "UNSUPPORTED" ? "unsupported" : "failed",
    };
  }

  const cursor = CURSOR[state as OnboardingState] ?? 0;
  return {
    steps: STEPS.map((step, i) => ({
      ...step,
      state: (i < cursor ? "done" : i === cursor ? "current" : "pending") as StepState,
    })),
    terminal: null,
  };
}

/** Whether a named step has completed for the given state; used by the architecture diagram. */
export function onboardingStepDone(state: OnboardingState | string | null | undefined, key: string): boolean {
  return onboardingView(state).steps.find((step) => step.key === key)?.state === "done";
}

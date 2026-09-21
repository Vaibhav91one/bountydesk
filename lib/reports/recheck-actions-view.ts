import type { RecheckSummary } from "./recheck-summary";

export type RecheckAction = "retry" | "cancel";

type RecheckDialogCopy = {
  title: string;
  description: string;
};

const GENERIC_RECHECK_ERROR = "The re-check could not be updated.";

const DIALOG_COPY: Record<RecheckAction, RecheckDialogCopy> = {
  retry: {
    title: "Retry this re-check?",
    description: "This puts the failed re-check back in the queue. It does not approve anything.",
  },
  cancel: {
    title: "Cancel this re-check?",
    description:
      "This stops waiting on the re-check and moves the report to Analysis only, where a reviewer decides. The earlier verdict stays superseded.",
  },
};

/**
 * Whether the "Ask to re-check" trigger should be offered on a parked verdict. A reproduced
 * verdict is only ever approved or denied: re-checking it risks a weaker follow-up run
 * superseding it with a NOT_REPRODUCED, which is the flip we saw on report #29.
 */
export function canOfferRecheck(outcome: string): boolean {
  return outcome !== "REPRODUCED";
}

export function recheckActionsFor(summary: RecheckSummary): RecheckAction[] {
  if (summary.runReason !== "REVIEWER_GUIDANCE" || summary.runId === null) return [];
  if (summary.runStatus === "ERROR") return ["retry", "cancel"];
  if (summary.runStatus === "PENDING") return ["cancel"];
  return [];
}

export function recheckDialogCopy(action: RecheckAction): RecheckDialogCopy {
  return DIALOG_COPY[action];
}

export function recheckFailedAnswerError(answer: { error?: string }): string {
  return answer.error ?? GENERIC_RECHECK_ERROR;
}

export function recheckThrownError(caught: unknown): string {
  return caught instanceof Error ? caught.message : GENERIC_RECHECK_ERROR;
}

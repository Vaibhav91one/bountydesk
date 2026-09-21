export type RecheckAction = "retry" | "cancel";

export function genericFailure(action: RecheckAction): string {
  return action === "retry"
    ? "Could not retry the re-check."
    : "Could not cancel the re-check.";
}

export function thrownActionError(_caught: unknown, action: RecheckAction): {
  ok: false;
  error: string;
} {
  return { ok: false, error: genericFailure(action) };
}

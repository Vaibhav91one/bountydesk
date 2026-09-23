export const RUN_NOT_FOUND = "The re-check run was not found.";

/** The reviewer actions whose thrown failures get a generic, non-leaking message. */
export type RecheckAction = "retry" | "cancel" | "bind" | "notify";

const FAILURE: Record<RecheckAction, string> = {
  retry: "Could not retry the re-check.",
  cancel: "Could not cancel the re-check.",
  bind: "Could not bind that target.",
  notify: "Could not ask for the owner to be notified.",
};

export function genericFailure(action: RecheckAction): string {
  return FAILURE[action];
}

export function thrownActionError(_caught: unknown, action: RecheckAction): {
  ok: false;
  error: string;
} {
  return { ok: false, error: genericFailure(action) };
}

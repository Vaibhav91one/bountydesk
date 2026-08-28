"use client";

import { useState } from "react";
import { GitHubLight } from "developer-icons";

import { RollingIcon } from "@/components/rolling-icon";
import { Button } from "@/components/ui/button";

/**
 * The GitHub button, with the wait made visible.
 *
 * /api/auth/github redirects out to GitHub, so the browser sits on this page with nothing
 * happening for as long as the round trip takes. Without the spinner the only feedback is
 * that the button looks clickable again, which invites a second click and a second OAuth
 * state. The click is not prevented: the navigation is what has to happen.
 */
export function SignInButton() {
  const [leaving, setLeaving] = useState(false);

  return (
    <Button
      variant="outline"
      nativeButton={false}
      loading={leaving}
      onClick={() => setLeaving(true)}
      render={<a href="/api/auth/github" />}
      className="h-11 w-full justify-center gap-2.5"
    >
      {leaving ? null : <RollingIcon icon={GitHubLight} className="size-4" />}
      Continue with GitHub
    </Button>
  );
}

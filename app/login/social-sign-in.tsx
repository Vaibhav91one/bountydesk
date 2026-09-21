"use client";

import { useState } from "react";
import { GitHubLight, Google } from "developer-icons";
import { useSignIn } from "@clerk/nextjs";
import { Warning } from "@phosphor-icons/react/ssr";

import { RollingIcon } from "@/components/rolling-icon";
import { Button } from "@/components/ui/button";

type Provider = "github" | "google";

/**
 * The two sign-in buttons. The card and its wording are ours; Clerk only does the OAuth: each
 * button hands off to the provider and returns through /sso-callback. The spinner makes the
 * redirect's round trip visible, and both buttons lock while one is in flight so a second click
 * cannot open a second OAuth attempt.
 */
export function SocialSignIn() {
  const { signIn } = useSignIn();
  const [pending, setPending] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(provider: Provider) {
    if (!signIn || pending) return;
    setPending(provider);
    setError(null);
    // On success the browser navigates out to the provider, so nothing runs after; on failure sso
    // resolves with an error rather than throwing. redirectCallbackUrl is where the provider
    // returns (the /sso-callback page finishes the flow); redirectUrl is the final destination.
    const { error: ssoError } = await signIn.sso({
      strategy: provider === "github" ? "oauth_github" : "oauth_google",
      redirectUrl: "/home",
      redirectCallbackUrl: "/sso-callback",
    });
    if (ssoError) {
      setPending(null);
      setError("Could not start sign-in. Try again.");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-body text-destructive"
        >
          <Warning className="mt-px size-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}

      <Button
        variant="outline"
        loading={pending === "github"}
        disabled={pending !== null}
        onClick={() => void start("github")}
        className="h-11 w-full justify-center gap-2.5"
      >
        {pending === "github" ? null : <RollingIcon icon={GitHubLight} className="size-4" />}
        Continue with GitHub
      </Button>

      <Button
        variant="outline"
        loading={pending === "google"}
        disabled={pending !== null}
        onClick={() => void start("google")}
        className="h-11 w-full justify-center gap-2.5"
      >
        {pending === "google" ? null : <Google className="size-[18px]" />}
        Continue with Google
      </Button>
    </div>
  );
}

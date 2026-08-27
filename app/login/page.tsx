import { redirect } from "next/navigation";

import { currentSession } from "@/lib/auth/dal";

const MESSAGES: Record<string, string> = {
  state: "That login link did not start here. Try again.",
  forbidden: "That GitHub account is not on the reviewer list.",
  denied: "GitHub did not return an authorization code.",
  github: "GitHub would not confirm who you are. Try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentSession()) redirect("/settings/channels");

  const { error } = await searchParams;

  return (
    <main>
      <h1>BountyDesk</h1>
      <p>Sign in to review and approve triage verdicts.</p>

      {error ? <p role="alert">{MESSAGES[error] ?? "Login failed. Try again."}</p> : null}

      <a href="/api/auth/github">Continue with GitHub</a>

      <p>
        Signing in identifies you. It does not grant access to any repository: that comes
        from installing the BountyDesk GitHub App on the repositories you choose.
      </p>
    </main>
  );
}

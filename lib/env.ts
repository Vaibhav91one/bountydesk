/**
 * Server-side environment access.
 *
 * Every server secret is read through `requireSecret`, which refuses to hand back a value
 * that the browser can also see. Next.js inlines any `NEXT_PUBLIC_*` variable into the
 * client bundle, so a secret that reaches one is public from that build onwards and cannot
 * be un-published by deleting the variable later.
 */

/** Names whose values are exposed to the browser, so they can never hold a server secret. */
function publicNames(): string[] {
  return Object.keys(process.env).filter((name) => name.startsWith("NEXT_PUBLIC_"));
}

/**
 * Read a required server secret.
 *
 * Two ways a secret leaks to the client, both refused here: reading it from a `NEXT_PUBLIC_`
 * name directly, and pasting the same value into both a private and a public variable. The
 * second one is the realistic mistake, and nothing else would catch it.
 */
export function requireSecret(name: string): string {
  if (name.startsWith("NEXT_PUBLIC_")) {
    throw new Error(
      `${name} is a client-visible variable and must not be used for a server secret`,
    );
  }

  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set. Copy env.example to .env.local and fill it in.`,
    );
  }

  const leaked = publicNames().find((other) => process.env[other]?.trim() === value);
  if (leaked) {
    throw new Error(
      `${name} has the same value as ${leaked}, which ships to the browser. Use a different value or stop setting ${leaked}.`,
    );
  }

  return value;
}

/** Read a required non-secret setting. Missing is still fatal; the value may be public. */
export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set. Copy env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/**
 * The GitHub App's webhook signing secret. We own it, not the customer: with the App model
 * nobody pastes a secret anywhere, so there is one secret and it lives here.
 */
export function githubWebhookSecret(): string {
  return requireSecret("GITHUB_APP_WEBHOOK_SECRET");
}

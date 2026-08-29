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

/** The GitHub App's numeric id. Not a secret: it is the `iss` claim of a public JWT. */
export function githubAppId(): string {
  return requireEnv("GITHUB_APP_ID");
}

/** The App's private key, base64-encoded. Signs the App JWT used to mint installation tokens. */
export function githubAppPrivateKeyBase64(): string {
  return requireSecret("GITHUB_APP_PRIVATE_KEY_BASE64");
}

/** Bearer secret for the internal worker-tick routes. Nothing public may call these. */
export function workerInternalSecret(): string {
  return requireSecret("WORKER_INTERNAL_SECRET");
}

function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return ["localhost", "127.0.0.1", "::1"].includes(host);
}

/**
 * The TrueForge harness URL. Its local mode has no auth of its own, so a non-loopback address
 * with no API key would mean an unauthenticated agent harness sitting on the open network.
 * Refuse that combination outright rather than connect to it.
 */
export function trueforgeUrl(): string {
  const url = requireEnv("TRUEFORGE_URL");
  if (!isLoopbackUrl(url) && !trueforgeApiKey()) {
    throw new Error(
      `TRUEFORGE_URL (${url}) is not loopback and TRUEFORGE_API_KEY is blank. A remote ` +
        "TrueForge endpoint must be an authenticated private service or sit behind one.",
    );
  }
  return url;
}

/** Blank is legitimate for loopback local mode; only set when TrueForge sits behind auth. */
export function trueforgeApiKey(): string {
  return process.env.TRUEFORGE_API_KEY?.trim()
    ? requireSecret("TRUEFORGE_API_KEY")
    : "";
}

/**
 * Bearer secret the `publish_verdict` MCP route requires on every call. This authenticates
 * "is this really TrueForge calling," which is a separate concern from TrueForge's own
 * approval gate: the gate is the human control, this secret is what stops a caller from
 * skipping the gate and invoking the tool directly.
 */
export function mcpServerSecret(): string {
  return requireSecret("MCP_SERVER_SECRET");
}

/**
 * Bearer secret the scope-guard MCP route requires on every call. Same role as
 * `mcpServerSecret()`, for a separate connector: only the TrueForge harness's scope-guard
 * connector should ever be able to mint grants or edit the allowlist.
 */
export function scopeGuardToken(): string {
  return requireSecret("SCOPE_GUARD_TOKEN");
}

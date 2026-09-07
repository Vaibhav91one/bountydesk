import { type ClassifyOptions } from "./classify";

/**
 * A few app-specific hints the deterministic classifier cannot infer from the source: how to seed an
 * app whose setup runs through its own HTTP endpoint, and a config file that hardcodes the datastore
 * host by the compose service name. These are known passive test targets, keyed by repo, so DVWA and
 * its kin onboard end to end without a model in the loop. A repo not listed here classifies with no
 * hints: an env-based app needs none, and a file-config app that is not listed onboards its image but
 * may need its config rewrite added here (or set by a reviewer editing the plan, once that lands).
 */
const HINTS: Record<string, ClassifyOptions> = {
  "vaibhav91one/dvwa": {
    // Onboarding to CONFIGURED only needs the app to boot and answer, so the build creates the empty
    // database and user and stops there; DVWA creates its own tables from /setup.php at runtime (a
    // POST with its CSRF token, which the reproduction path drives, not the build). A `none` seed
    // also keeps the seed layer to a datastore bring-up, without starting Apache inside the build.
    composeSeedHint: { kind: "none" },
    // DVWA's "/" is a 302 to /login.php; the readiness poll wants a 2xx.
    readinessPathHint: "/login.php",
    // DVWA's config.inc.php names the datastore by the compose service `db`; rewrite it to loopback
    // so the app reaches the MariaDB bundled into the same image.
    configRewritesHint: [
      { file: "/var/www/html/config/config.inc.php", from: "'db'", to: "'127.0.0.1'" },
    ],
  },
};

export function knownTargetHints(repoFullName: string): ClassifyOptions {
  return HINTS[repoFullName.toLowerCase()] ?? {};
}

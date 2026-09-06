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
    // DVWA creates its schema by hitting /setup.php; the GET primes it, and the app also seeds on
    // first use. If a live run shows the tables are not created, this becomes a `command` seed that
    // runs DVWA's own database import against the bundled MariaDB.
    composeSeedHint: { kind: "http", method: "GET", path: "/setup.php" },
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

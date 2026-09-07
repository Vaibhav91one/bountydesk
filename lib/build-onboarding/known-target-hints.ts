import { type ClassifyOptions } from "./classify";

/**
 * A few app-specific hints the deterministic classifier cannot infer from the source: how to seed an
 * app whose setup runs through its own HTTP endpoint, and the environment that makes its reported
 * vulnerability reachable in an isolated sandbox. These are known passive test targets, keyed by repo,
 * so DVWA and its kin onboard end to end without a model in the loop. A repo not listed here classifies
 * with no hints: an env-based app needs none, and one that needs seeding onboards its image but reaches
 * a reviewer (or this file) for the seed step.
 */

/**
 * Create DVWA's database tables at build by driving its own /setup.php, the same "Create / Reset
 * Database" step a human clicks once after `docker compose up`. This runs inside the single seed RUN,
 * after MariaDB is up: start Apache in the background, fetch the setup page for its CSRF user_token,
 * POST the create-database action with it, then confirm the users table the SQLi labs read now exists.
 * A failure here fails the build loudly (the && chain stops before the lenient Apache kill), so an
 * image never ships with an empty database that would make every reproduction a false negative.
 */
const DVWA_SETUP_SEED_COMMAND = [
  "( apache2-foreground >/tmp/bd-apache.log 2>&1 & echo $! > /tmp/bd-apache.pid )",
  'for i in $(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:80/setup.php 2>/dev/null && break; sleep 1; done',
  // Match the token by anchoring on value= within the input tag, not by skipping non-hex up to it:
  // the word "value" itself contains hex letters, so a "skip non-hex" pattern stops short of the
  // real token. The `.` after value= consumes the opening quote, \K drops everything before the hex.
  'TOKEN=$(curl -fsSL -c /tmp/bd-cj http://127.0.0.1:80/setup.php | grep -oP "user_token[^>]*value=.\\K[0-9a-f]{32}" | head -n1)',
  'test -n "$TOKEN"',
  'curl -fsSL -b /tmp/bd-cj -c /tmp/bd-cj -X POST http://127.0.0.1:80/setup.php --data-urlencode "create_db=Create / Reset Database" --data-urlencode "user_token=$TOKEN" -o /tmp/bd-setup.html',
  // Confirm the users table the SQLi labs read now exists, retried: creating the schema can make
  // the datastore briefly restart under a memory-tight build, and the socket is gone in that window.
  'for i in $(seq 1 30); do mysql --protocol=socket dvwa -e "SELECT COUNT(*) FROM users" >/dev/null 2>&1 && break; sleep 1; done',
  'mysql --protocol=socket dvwa -e "SELECT COUNT(*) FROM users"',
  '{ kill "$(cat /tmp/bd-apache.pid)" 2>/dev/null || true; }',
].join(" && ");

const HINTS: Record<string, ClassifyOptions> = {
  "vaibhav91one/dvwa": {
    // DVWA creates its schema and default users from /setup.php, not on boot, so seed it at build.
    composeSeedHint: { kind: "command", command: DVWA_SETUP_SEED_COMMAND },
    // DVWA reads every setting from the environment (config.inc.php.dist is getenv-with-fallbacks). The
    // datastore pass already rewrites DB_SERVER to loopback; these are the two the compose does not set
    // and that a reproduction needs: the reported SQLi lives on the `low` security path, DVWA's default
    // is `impossible` (which is not injectable), and disabling the login wall lets a stateless probe
    // reach the vulnerable page without carrying a session. Both only widen a deliberately vulnerable
    // test app inside a no-egress throwaway sandbox.
    envOverridesHint: {
      DEFAULT_SECURITY_LEVEL: "low",
      DISABLE_AUTHENTICATION: "true",
    },
    // /setup.php is unconditionally a 200, unlike "/" (a 302 to login) or /login.php once auth is off,
    // so it is the readiness signal that the app booted and its config loaded.
    readinessPathHint: "/setup.php",
  },
};

export function knownTargetHints(repoFullName: string): ClassifyOptions {
  return HINTS[repoFullName.toLowerCase()] ?? {};
}

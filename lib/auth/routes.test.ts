import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

/**
 * The login routes end to end.
 *
 * Everything security-relevant about a login lives in the ordering of the callback's
 * checks, not in the helpers it calls, so these drive the handlers themselves. The routes
 * read cookies off the Request and write Set-Cookie headers, which is ordinary Web API
 * usage, so nothing had to be loosened to make this possible. GitHub is the one thing
 * stubbed, because a test that talks to github.com is not a test.
 */
process.env.APP_BASE_URL = "https://bountydesk.test";
process.env.AUTH_SECRET = Buffer.alloc(32, "s").toString("base64");
process.env.GITHUB_APP_CLIENT_ID = "Iv1.testclientid";
process.env.GITHUB_APP_CLIENT_SECRET = "test-client-secret";
process.env.GITHUB_APP_SLUG = "bountydesk";
process.env.REVIEWER_GITHUB_IDS = "583231";

const REVIEWER = { login: "octocat", id: 583231 };

import { GET as authorize } from "@/app/api/auth/github/route";
import { GET as callback } from "@/app/api/auth/github/callback/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { STATE_COOKIE, VERIFIER_COOKIE, challengeFor } from "./oauth";
import { SESSION_COOKIE, unseal } from "./session";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub GitHub. Each entry is either a response spec or an error to throw. */
function stubGitHub(token: unknown, user?: unknown) {
  const responses = [token, user];
  let call = 0;

  globalThis.fetch = (async () => {
    const spec = responses[call++];
    if (spec instanceof Error) throw spec;

    const { status = 200, body = {} } = (spec ?? {}) as { status?: number; body?: unknown };

    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function cookiesOf(response: Response): Map<string, string> {
  const jar = new Map<string, string>();

  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const eq = pair.indexOf("=");
    jar.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)));
  }

  return jar;
}

function callbackRequest({
  state,
  stateCookie,
  verifierCookie,
  code = "the-code",
}: {
  state?: string;
  stateCookie?: string;
  verifierCookie?: string;
  code?: string | null;
}): Request {
  const url = new URL("https://bountydesk.test/api/auth/github/callback");
  if (state !== undefined) url.searchParams.set("state", state);
  if (code !== null) url.searchParams.set("code", code);

  const jar = [
    stateCookie === undefined ? null : `${STATE_COOKIE}=${stateCookie}`,
    verifierCookie === undefined ? null : `${VERIFIER_COOKIE}=${verifierCookie}`,
  ].filter(Boolean);

  return new Request(url, { headers: jar.length ? { cookie: jar.join("; ") } : {} });
}

/** A callback that is well-formed up to whatever GitHub does next. */
function goodRequest(): Request {
  return callbackRequest({
    state: "the-state",
    stateCookie: "the-state",
    verifierCookie: "the-verifier",
  });
}

function assertLoginError(response: Response, reason: string) {
  const jar = cookiesOf(response);

  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("location") as string).searchParams.get("error"), reason);
  assert.equal(jar.get(SESSION_COOKIE), undefined, "no session is issued");
}

/** A callback that owned the flow spends both cookies, whatever the outcome. */
function assertFlowSpent(response: Response) {
  const jar = cookiesOf(response);

  assert.equal(jar.get(STATE_COOKIE), "", "the state cookie is cleared");
  assert.equal(jar.get(VERIFIER_COOKIE), "", "the verifier cookie is cleared");
}

/** A callback that failed the state check owned nothing and must leave the cookies alone. */
function assertFlowUntouched(response: Response) {
  assert.deepEqual(response.headers.getSetCookie(), [], "no cookie is touched");
}

test("the authorize request carries PKCE and asks for no scopes", async () => {
  const response = await authorize();
  const jar = cookiesOf(response);
  const url = new URL(response.headers.get("location") as string);

  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("scope"), null);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), jar.get(STATE_COOKIE));
  assert.equal(
    url.searchParams.get("code_challenge"),
    challengeFor(jar.get(VERIFIER_COOKIE) as string),
  );

  for (const header of response.headers.getSetCookie()) {
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, /Secure/);
  }
});

test("a callback with no state is refused", async () => {
  const response = await callback(callbackRequest({}));

  assertLoginError(response, "state");
  assertFlowUntouched(response);
});

test("a stale callback is refused without spending a newer login's cookies", async () => {
  // Two logins overlap in one browser: the second one's cookies are in the jar when the
  // first one's callback finally arrives. Clearing them here would take the live attempt
  // down as well, and the operator would be unable to log in at all.
  const response = await callback(
    callbackRequest({
      state: "older-state",
      stateCookie: "newer-state",
      verifierCookie: "newer-verifier",
    }),
  );

  assertLoginError(response, "state");
  assertFlowUntouched(response);

  // The newer flow still completes.
  stubGitHub({ body: { access_token: "t" } }, { body: REVIEWER });
  const newer = await callback(
    callbackRequest({
      state: "newer-state",
      stateCookie: "newer-state",
      verifierCookie: "newer-verifier",
    }),
  );

  assert.equal(newer.headers.get("location"), "https://bountydesk.test/settings/channels");
  assert.ok(unseal(cookiesOf(newer).get(SESSION_COOKIE)));
});

test("a cookie value that cannot be decoded fails the login rather than the process", async () => {
  const request = new Request(
    "https://bountydesk.test/api/auth/github/callback?state=the-state&code=the-code",
    { headers: { cookie: `${STATE_COOKIE}=%; ${VERIFIER_COOKIE}=the-verifier` } },
  );

  const response = await callback(request);

  assertLoginError(response, "state");
});

test("a callback with no PKCE verifier is refused", async () => {
  const request = callbackRequest({ state: "the-state", stateCookie: "the-state" });
  const response = await callback(request);

  assertLoginError(response, "state");
  assertFlowSpent(response);
});

test("a callback with no authorization code is refused", async () => {
  const request = callbackRequest({
    state: "the-state",
    stateCookie: "the-state",
    verifierCookie: "the-verifier",
    code: null,
  });
  const response = await callback(request);

  assertLoginError(response, "denied");
  assertFlowSpent(response);
});

test("every way GitHub can fail ends as a login error, not a 500", async () => {
  const failures: Record<string, [unknown, unknown?]> = {
    "connection refused": [new Error("ECONNREFUSED")],
    timeout: [new Error("The operation was aborted due to timeout")],
    "token endpoint 500": [{ status: 500 }],
    "token endpoint returns html": [{ body: "<html>maintenance</html>" }],
    "no access token": [{ body: { error: "bad_verification_code" } }],
    "access token is not a string": [{ body: { access_token: 12345 } }],
    "user endpoint 401": [{ body: { access_token: "t" } }, { status: 401 }],
    "user endpoint returns html": [{ body: { access_token: "t" } }, { body: "<html>" }],
    "user has no login": [{ body: { access_token: "t" } }, { body: { id: 1 } }],
    "user id is a string": [
      { body: { access_token: "t" } },
      { body: { login: "octocat", id: "1" } },
    ],
  };

  for (const [name, [token, user]] of Object.entries(failures)) {
    stubGitHub(token, user);
    const response = await callback(goodRequest());

    assert.equal(response.status, 302, name);
    assertLoginError(response, "github");
    assertFlowSpent(response);
  }
});

test("a GitHub account that is not on the reviewer list gets no session", async () => {
  stubGitHub({ body: { access_token: "t" } }, { body: { login: "stranger", id: 999 } });

  const response = await callback(goodRequest());

  assertLoginError(response, "forbidden");
  assertFlowSpent(response);
});

test("a reviewer gets a session and lands on the connections page", async () => {
  stubGitHub({ body: { access_token: "t" } }, { body: REVIEWER });

  const response = await callback(goodRequest());
  const jar = cookiesOf(response);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://bountydesk.test/settings/channels");

  const session = unseal(jar.get(SESSION_COOKIE));
  assert.equal(session?.login, REVIEWER.login);
  assert.equal(session?.userId, REVIEWER.id);

  assert.equal(jar.get(STATE_COOKIE), "", "the state cookie is spent");
  assert.equal(jar.get(VERIFIER_COOKIE), "", "the verifier cookie is spent");
});

test("the token exchange sends the verifier and never leaks the token", async () => {
  let sent: Record<string, unknown> = {};

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.includes("access_token")) {
      sent = JSON.parse(init?.body as string);
      return Response.json({ access_token: "super-secret-token" });
    }

    return Response.json(REVIEWER);
  }) as typeof fetch;

  const response = await callback(goodRequest());

  assert.equal(sent.code_verifier, "the-verifier");
  assert.equal(sent.code, "the-code");

  const serialized = JSON.stringify([...response.headers.entries()]);
  assert.equal(serialized.includes("super-secret-token"), false);
});

test("logout refuses a cross-origin or origin-less POST", async () => {
  for (const origin of [null, "https://evil.test", "https://bountydesk.test.evil.test", ""]) {
    const headers: Record<string, string> = origin === null ? {} : { origin };
    const response = await logout(
      new Request("https://bountydesk.test/api/auth/logout", { method: "POST", headers }),
    );

    assert.equal(response.status, 403, String(origin));
    assert.deepEqual(response.headers.getSetCookie(), [], "no cookie is touched");
  }
});

test("logout from our own origin clears the session", async () => {
  const response = await logout(
    new Request("https://bountydesk.test/api/auth/logout", {
      method: "POST",
      headers: { origin: "https://bountydesk.test" },
    }),
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://bountydesk.test/login");
  assert.equal(cookiesOf(response).get(SESSION_COOKIE), "");
});

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { after, before } from "node:test";

/**
 * Intake is the trust boundary, so these tests drive the real route handler against a real
 * Postgres rather than calling the helpers directly. What is asserted is what an attacker
 * would try: an unsigned delivery, a replay, and a signed delivery for access that has
 * since been withdrawn.
 */
const SECRET = "intake-test-secret";
process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;

const INSTALLATION_ID = 4242;
const REPO_ID = 909090;
const REPO_NAME = "acme/security-reports";

let schema: import("@/lib/db/testing").DisposableSchema;

// Imported dynamically so DATABASE_SCHEMA is set before the pool is constructed.
let POST: typeof import("@/app/api/intake/github/route").POST;
let dbm: typeof import("@/lib/db");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("intake");

  dbm = await import("@/lib/db");
  ({ POST } = await import("@/app/api/intake/github/route"));
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let deliveries = 0;

function request(
  event: string,
  payload: unknown,
  { secret = SECRET, deliveryId = `delivery-${deliveries++}` } = {},
): Request {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  return new Request("https://bountydesk.test/api/intake/github", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature,
    },
  });
}

/** A signed `issues.opened` for the connected repository. */
function issueOpened(number: number): Request {
  return request("issues", {
    action: "opened",
    issue: { number, title: `report ${number}`, body: "steps to reproduce" },
    repository: { id: REPO_ID, full_name: REPO_NAME },
    installation: { id: INSTALLATION_ID },
  });
}

function installationEvent(action: string, deliveryId?: string): Request {
  return request(
    "installation",
    {
      action,
      installation: {
        id: INSTALLATION_ID,
        account: { login: "acme", id: 77 },
      },
      repositories: [{ id: REPO_ID, full_name: REPO_NAME }],
    },
    deliveryId ? { deliveryId } : {},
  );
}

function repositoryEvent(action: string, fullName = REPO_NAME): Request {
  return request("repository", {
    action,
    repository: { id: REPO_ID, full_name: fullName },
    installation: { id: INSTALLATION_ID },
  });
}

async function isConnected(): Promise<boolean> {
  const { activeRepository } = await import("./lifecycle");
  return (await activeRepository(INSTALLATION_ID, REPO_ID)) !== null;
}

async function jobCount(): Promise<number> {
  const rows = await dbm.db.select({ id: dbm.inboundJob.id }).from(dbm.inboundJob);
  return rows.length;
}

test("an unsigned delivery is rejected and writes nothing", async () => {
  const before = await jobCount();

  const forged = request("issues", { action: "opened" }, { secret: "not-the-webhook-secret" });
  const response = await POST(forged);

  assert.equal(response.status, 401);
  assert.equal(await jobCount(), before);
});

test("a delivery missing its event headers is rejected", async () => {
  const body = JSON.stringify({ action: "opened" });
  const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

  const response = await POST(
    new Request("https://bountydesk.test/api/intake/github", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": signature },
    }),
  );

  assert.equal(response.status, 400);
});

test("an issue on an unknown repository is accepted but not queued", async () => {
  const before = await jobCount();

  const response = await POST(issueOpened(1));

  assert.equal(response.status, 202);
  assert.equal(await jobCount(), before);
});

test("installing the App connects the selected repositories", async () => {
  await POST(installationEvent("created", "install-1"));

  const { activeRepository } = await import("./lifecycle");
  const repo = await activeRepository(INSTALLATION_ID, REPO_ID);

  assert.equal(repo?.fullName, REPO_NAME);
});

test("a signed issue on a connected repository is queued exactly once", async () => {
  const before = await jobCount();

  const opened = issueOpened(2);
  assert.equal((await POST(opened.clone())).status, 202);
  assert.equal(await jobCount(), before + 1);

  // GitHub redelivers on its own timers. The same delivery id must not start a second run.
  const replay = await POST(opened);
  assert.equal(replay.status, 202);
  assert.equal(await replay.text(), "IN_FLIGHT");
  assert.equal(await jobCount(), before + 1);
});

test("suspending the installation stops intake immediately", async () => {
  await POST(installationEvent("suspend"));

  const before = await jobCount();
  const response = await POST(issueOpened(3));

  assert.equal(response.status, 202);
  assert.equal(await response.text(), "repository is not connected");
  assert.equal(await jobCount(), before);
});

test("unsuspending the installation restores intake", async () => {
  await POST(installationEvent("unsuspend"));

  const before = await jobCount();
  await POST(issueOpened(4));

  assert.equal(await jobCount(), before + 1);
});

test("removing the repository from the installation stops intake", async () => {
  await POST(
    request("installation_repositories", {
      action: "removed",
      installation: { id: INSTALLATION_ID, account: { login: "acme", id: 77 } },
      repositories_removed: [{ id: REPO_ID, full_name: REPO_NAME }],
    }),
  );

  const before = await jobCount();
  await POST(issueOpened(5));

  assert.equal(await jobCount(), before);
});

test("uninstalling the App stops intake even after the repository is re-added", async () => {
  await POST(
    request("installation_repositories", {
      action: "added",
      installation: { id: INSTALLATION_ID, account: { login: "acme", id: 77 } },
      repositories_added: [{ id: REPO_ID, full_name: REPO_NAME }],
    }),
  );
  await POST(installationEvent("deleted"));

  const before = await jobCount();
  await POST(issueOpened(6));

  assert.equal(await jobCount(), before);
});

test("an oversized body is rejected before the signature is checked", async () => {
  const { MAX_WEBHOOK_BYTES } = await import("./webhook");

  const response = await POST(
    new Request("https://bountydesk.test/api/intake/github", {
      method: "POST",
      body: "x".repeat(MAX_WEBHOOK_BYTES + 1),
      headers: { "x-github-event": "issues", "x-github-delivery": "oversized" },
    }),
  );

  assert.equal(response.status, 413);
});

test("redelivering the install event does not undo the uninstall", async () => {
  // GitHub keeps the delivery id across a retry and across a human pressing Redeliver, so
  // this is the same delivery that connected the repository in the first place.
  const response = await POST(installationEvent("created", "install-1"));

  assert.equal(await response.text(), "already applied");
  assert.equal(await isConnected(), false);
});

test("a fresh install event after an uninstall reconnects", async () => {
  await POST(installationEvent("created", "reinstall-1"));

  assert.equal(await isConnected(), true);
});

test("going private leaves the repository connected", async () => {
  await POST(repositoryEvent("privatized"));

  assert.equal(await isConnected(), true);
});

test("a transferred repository stops being connected", async () => {
  await POST(repositoryEvent("transferred", "newowner/security-reports"));

  assert.equal(await isConnected(), false);
});

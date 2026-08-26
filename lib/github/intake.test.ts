import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { after, before } from "node:test";

/**
 * Intake is the trust boundary, so these tests drive the real route handler against a real
 * Postgres rather than calling the helpers directly.
 *
 * Every test builds the state it needs from scratch under its own installation and
 * repository ids. GitHub does not deliver webhooks in order, so most of what is asserted
 * here is what happens when a stale positive event lands after the revocation it precedes,
 * and a test that inherited another test's rows could not say anything about that.
 */
const SECRET = "intake-test-secret";
process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;

let schema: import("@/lib/db/testing").DisposableSchema;

// Imported dynamically so DATABASE_SCHEMA is set before the pool is constructed.
let POST: typeof import("@/app/api/intake/github/route").POST;
let dbm: typeof import("@/lib/db");
let lifecycle: typeof import("./lifecycle");

/** The legal target every admissible repository is bound to. */
let targetProfileId: string;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("intake");

  dbm = await import("@/lib/db");
  ({ POST } = await import("@/app/api/intake/github/route"));
  lifecycle = await import("./lifecycle");

  const [profile] = await dbm.db
    .insert(dbm.targetProfile)
    .values({
      name: "juice-shop-v17.3.0",
      imageDigest: "sha256:" + "0".repeat(64),
    })
    .returning({ id: dbm.targetProfile.id });

  targetProfileId = profile.id;
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let ids = 0;
let deliveries = 0;

/** A fresh installation and repository, so no test can inherit another's state. */
function fixture() {
  ids += 1;
  return {
    installationId: 100_000 + ids,
    repoId: 900_000 + ids,
    fullName: `acme/reports-${ids}`,
  };
}

type Fixture = ReturnType<typeof fixture>;

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

function installationEvent(
  f: Fixture,
  action: string,
  options: { deliveryId?: string; repositories?: boolean } = {},
): Request {
  return request(
    "installation",
    {
      action,
      installation: {
        id: f.installationId,
        account: { login: "acme", id: 77 },
      },
      repositories: options.repositories === false ? [] : [{ id: f.repoId, full_name: f.fullName }],
    },
    options.deliveryId ? { deliveryId: options.deliveryId } : {},
  );
}

function repositoriesEvent(f: Fixture, action: "added" | "removed"): Request {
  const list = [{ id: f.repoId, full_name: f.fullName }];
  return request("installation_repositories", {
    action,
    installation: { id: f.installationId, account: { login: "acme", id: 77 } },
    ...(action === "added" ? { repositories_added: list } : { repositories_removed: list }),
  });
}

function repositoryEvent(f: Fixture, action: string, fullName = f.fullName): Request {
  return request("repository", {
    action,
    repository: { id: f.repoId, full_name: fullName },
    installation: { id: f.installationId },
  });
}

function issueOpened(f: Fixture): Request {
  return request("issues", {
    action: "opened",
    issue: { number: 1, title: "report", body: "steps to reproduce" },
    repository: { id: f.repoId, full_name: f.fullName },
    installation: { id: f.installationId },
  });
}

/** What an operator does in the settings surface: bind the repository to a legal target. */
async function configure(f: Fixture): Promise<void> {
  await dbm.db
    .update(dbm.connectedRepository)
    .set({ targetProfileId })
    .where(dbm.eq(dbm.connectedRepository.repoId, f.repoId));
}

/** Install the App and configure the repository, the state a live demo repo is in. */
async function connect(f: Fixture): Promise<void> {
  await POST(installationEvent(f, "created"));
  await configure(f);
}

async function admits(f: Fixture): Promise<boolean> {
  return (await lifecycle.activeRepository(f.installationId, f.repoId)) !== null;
}

async function jobCount(f?: Fixture): Promise<number> {
  const rows = await dbm.db.select({ payload: dbm.inboundJob.payload }).from(dbm.inboundJob);
  if (!f) return rows.length;

  return rows.filter(
    (r) => (r.payload as { repository?: { id?: number } }).repository?.id === f.repoId,
  ).length;
}

test("an unsigned delivery is rejected and writes nothing", async () => {
  const f = fixture();
  const before = await Promise.all([
    jobCount(),
    dbm.db.select().from(dbm.lifecycleDelivery),
    dbm.db.select().from(dbm.githubInstallation),
    dbm.db.select().from(dbm.connectedRepository),
  ]);

  const forged = request("installation", { action: "created", installation: { id: f.installationId } }, {
    secret: "not-the-webhook-secret",
  });
  const response = await POST(forged);

  assert.equal(response.status, 401);

  const after = await Promise.all([
    jobCount(),
    dbm.db.select().from(dbm.lifecycleDelivery),
    dbm.db.select().from(dbm.githubInstallation),
    dbm.db.select().from(dbm.connectedRepository),
  ]);

  assert.equal(after[0], before[0], "inbound_job");
  assert.equal(after[1].length, before[1].length, "lifecycle_delivery");
  assert.equal(after[2].length, before[2].length, "github_installation");
  assert.equal(after[3].length, before[3].length, "connected_repository");
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

test("a configured repository admits a signed issue exactly once", async () => {
  const f = fixture();
  await connect(f);

  const opened = issueOpened(f);
  assert.equal((await POST(opened.clone())).status, 202);
  assert.equal(await jobCount(f), 1);

  // GitHub redelivers on its own timers. The same delivery id must not start a second run.
  const replay = await POST(opened);
  assert.equal(await replay.text(), "IN_FLIGHT");
  assert.equal(await jobCount(f), 1);
});

test("an installed but unconfigured repository creates no job", async () => {
  const f = fixture();
  await POST(installationEvent(f, "created"));

  const response = await POST(issueOpened(f));

  assert.equal(response.status, 202);
  assert.equal(await response.text(), "repository is not connected");
  assert.equal(await jobCount(f), 0);
});

test("an issue on a repository we have never seen creates no job", async () => {
  const f = fixture();

  assert.equal((await POST(issueOpened(f))).status, 202);
  assert.equal(await jobCount(f), 0);
});

test("suspending stops intake, and unsuspending alone does not restore it", async () => {
  const f = fixture();
  await connect(f);

  await POST(installationEvent(f, "suspend"));
  assert.equal(await admits(f), false);

  await POST(installationEvent(f, "unsuspend"));
  assert.equal(
    await admits(f),
    false,
    "unsuspend lifts the suspension; the target binding is the operator's to restore",
  );

  await configure(f);
  assert.equal(await admits(f), true);
});

test("a stale positive event after a suspension does not restore intake", async () => {
  const f = fixture();
  await connect(f);

  await POST(installationEvent(f, "suspend"));

  // Delivered late, under its own delivery id, so the replay guard does not apply.
  await POST(installationEvent(f, "created"));
  await POST(repositoriesEvent(f, "added"));

  assert.equal(await admits(f), false);
});

test("a deleted installation is a tombstone that a later created cannot revive", async () => {
  const f = fixture();
  await connect(f);

  await POST(installationEvent(f, "deleted"));
  assert.equal(await admits(f), false);

  await POST(installationEvent(f, "created"));
  await POST(installationEvent(f, "unsuspend"));
  await configure(f);

  assert.equal(await admits(f), false, "a real reinstall arrives under a new installation id");
  assert.equal(await jobCount(f), 0);
});

test("reinstalling under a new installation id connects normally", async () => {
  const first = fixture();
  await connect(first);
  await POST(installationEvent(first, "deleted"));

  const second = { ...fixture(), repoId: first.repoId, fullName: first.fullName };
  await connect(second);

  assert.equal(await admits(second), true);
});

test("deletion arriving before the install still denies", async () => {
  const f = fixture();

  await POST(installationEvent(f, "deleted", { repositories: false }));
  await POST(installationEvent(f, "created"));
  await configure(f);

  assert.equal(await admits(f), false);
});

test("suspension arriving before the install still denies", async () => {
  const f = fixture();

  await POST(installationEvent(f, "suspend", { repositories: false }));
  await POST(installationEvent(f, "created"));
  await configure(f);

  assert.equal(await admits(f), false);
});

test("a delayed added after a removal does not restore intake", async () => {
  const f = fixture();
  await connect(f);

  await POST(repositoriesEvent(f, "removed"));
  assert.equal(await admits(f), false);

  await POST(repositoriesEvent(f, "added"));
  assert.equal(await admits(f), false, "the grant returns; the target binding does not");
});

test("unarchiving does not restore a repository that was removed", async () => {
  const f = fixture();
  await connect(f);

  await POST(repositoriesEvent(f, "removed"));
  await POST(repositoryEvent(f, "unarchived"));

  assert.equal(await admits(f), false);
});

test("archiving and unarchiving leave the installation grant alone", async () => {
  const f = fixture();
  await connect(f);

  await POST(repositoryEvent(f, "archived"));
  assert.equal(await admits(f), false);

  await POST(repositoryEvent(f, "unarchived"));
  assert.equal(await admits(f), true, "archive state is separate from the grant");
});

test("going private leaves the repository connected", async () => {
  const f = fixture();
  await connect(f);

  await POST(repositoryEvent(f, "privatized"));

  assert.equal(await admits(f), true);
});

test("a transferred repository stops being connected", async () => {
  const f = fixture();
  await connect(f);

  await POST(repositoryEvent(f, "transferred", "newowner/reports"));

  assert.equal(await admits(f), false);
});

test("redelivering the install event does not undo an uninstall", async () => {
  const f = fixture();
  await POST(installationEvent(f, "created", { deliveryId: "install-once" }));
  await configure(f);
  await POST(installationEvent(f, "deleted"));

  const response = await POST(installationEvent(f, "created", { deliveryId: "install-once" }));

  assert.equal(await response.text(), "already applied");
  assert.equal(await admits(f), false);
});

test("an unrelated lifecycle event does not clear a revocation", async () => {
  const f = fixture();
  await connect(f);
  await POST(installationEvent(f, "suspend"));

  await POST(repositoryEvent(f, "renamed", "acme/renamed"));
  await POST(installationEvent(f, "new_permissions_accepted"));

  assert.equal(await admits(f), false);
});

/**
 * The FOR SHARE lock in activeRepository is the only thing standing between "access was
 * checked" and "the job exists". This drives the two orderings against a real Postgres from
 * two connections, because the guarantee is the database's and a mock would agree with a
 * broken implementation.
 */
test("a revocation cannot commit between the access check and the enqueue", async () => {
  const f = fixture();
  await connect(f);

  const { enqueue } = await import("@/lib/jobs/queue");

  let revocationSettled = false;
  let revocation: Promise<unknown> | null = null;

  await dbm.db.transaction(async (tx) => {
    const repository = await lifecycle.activeRepository(f.installationId, f.repoId, {
      tx,
      lock: true,
    });
    assert.ok(repository, "the repository is admissible at the moment of the check");

    // A competing suspension on its own connection. It touches the row this transaction
    // holds FOR SHARE, so it has to wait for the commit below.
    revocation = schema.admin
      .unsafe(
        `set search_path to "${schema.name}";
         update github_installation set suspended_at = now()
          where installation_id = ${f.installationId}`,
      )
      .then(() => {
        revocationSettled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(revocationSettled, false, "the revocation is blocked on the lock");

    await enqueue({ channel: "github", deliveryId: `concurrent-${f.repoId}`, payload: {} }, tx);
  });

  await revocation;

  assert.equal(revocationSettled, true, "the revocation lands once the enqueue commits");
  assert.equal(await admits(f), false, "and it takes effect");
});

test("a revocation that wins the race stops the job being created", async () => {
  const f = fixture();
  await connect(f);

  await schema.admin.unsafe(
    `set search_path to "${schema.name}";
     update github_installation set suspended_at = now()
      where installation_id = ${f.installationId}`,
  );

  const response = await POST(issueOpened(f));

  assert.equal(await response.text(), "repository is not connected");
  assert.equal(await jobCount(f), 0);
});

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { after, before } from "node:test";

/**
 * Advisory intake is a trust boundary like issue intake, so these tests drive the real route
 * handler against a real Postgres. They cover the dispatch (which actions start a run), the
 * connectivity gate, and the (channel, delivery_id) idempotency that makes a GitHub redelivery a
 * no-op. The advisory body read and report creation happen later in the jobs worker, not here.
 */
const SECRET = "advisory-intake-test-secret";
process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;

let schema: import("@/lib/db/testing").DisposableSchema;
let POST: typeof import("@/app/api/intake/github/route").POST;
let dbm: typeof import("@/lib/db");

let targetProfileId: string;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("advisory_intake");

  dbm = await import("@/lib/db");
  ({ POST } = await import("@/app/api/intake/github/route"));

  const [profile] = await dbm.db
    .insert(dbm.targetProfile)
    .values({ name: "adv-target", imageDigest: "sha256:" + "0".repeat(64) })
    .returning({ id: dbm.targetProfile.id });
  targetProfileId = profile.id;
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let ids = 0;
let deliveries = 0;

function fixture() {
  ids += 1;
  return { installationId: 200_000 + ids, repoId: 300_000 + ids, fullName: `acme/adv-${ids}` };
}
type Fixture = ReturnType<typeof fixture>;

function request(
  event: string,
  payload: unknown,
  { secret = SECRET, deliveryId = `adv-delivery-${deliveries++}` } = {},
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

/** Install the App (which grants the repo) and bind a target, the state a live repo is in. */
async function connect(f: Fixture): Promise<void> {
  await POST(
    request("installation", {
      action: "created",
      installation: { id: f.installationId, account: { login: "acme", id: 77 } },
      repositories: [{ id: f.repoId, full_name: f.fullName, private: false }],
    }),
  );
  await dbm.db
    .update(dbm.connectedRepository)
    .set({ targetProfileId })
    .where(dbm.eq(dbm.connectedRepository.repoId, f.repoId));
}

function advisoryEvent(
  f: Fixture,
  action: string,
  { ghsaId = "GHSA-aaaa-bbbb-cccc", deliveryId }: { ghsaId?: string; deliveryId?: string } = {},
): Request {
  return request(
    "repository_advisory",
    {
      action,
      repository_advisory: { ghsa_id: ghsaId, summary: "advisory summary", description: "advisory body" },
      sender: { id: 4242, login: "reporter" },
      repository: { id: f.repoId, full_name: f.fullName },
      installation: { id: f.installationId },
    },
    deliveryId ? { deliveryId } : {},
  );
}

async function advisoryJobs(f: Fixture) {
  const rows = await dbm.db
    .select({ channel: dbm.inboundJob.channel, payload: dbm.inboundJob.payload })
    .from(dbm.inboundJob);
  return rows.filter(
    (r) =>
      r.channel === "advisory" &&
      (r.payload as { repository?: { id?: number } }).repository?.id === f.repoId,
  );
}

test("an unsigned advisory delivery is rejected before it reaches the queue", async () => {
  const f = fixture();
  await connect(f);
  const forged = advisoryEvent(f, "reported");
  const bad = new Request(forged, { headers: { ...Object.fromEntries(forged.headers), "x-hub-signature-256": "sha256=deadbeef" } });

  const response = await POST(bad);
  assert.equal(response.status, 401);
  assert.equal((await advisoryJobs(f)).length, 0);
});

test("a configured repository admits a reported advisory exactly once", async () => {
  const f = fixture();
  await connect(f);

  const reported = advisoryEvent(f, "reported");
  assert.equal((await POST(reported.clone())).status, 202);
  const jobs = await advisoryJobs(f);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].channel, "advisory");

  // GitHub redelivers on its own timers; the same delivery id must not start a second run.
  const replay = await POST(reported);
  assert.equal(await replay.text(), "IN_FLIGHT");
  assert.equal((await advisoryJobs(f)).length, 1);
});

test("a published advisory is admitted as well", async () => {
  const f = fixture();
  await connect(f);

  assert.equal((await POST(advisoryEvent(f, "published"))).status, 202);
  assert.equal((await advisoryJobs(f)).length, 1);
});

test("an advisory action other than reported or published starts no run", async () => {
  const f = fixture();
  await connect(f);

  const response = await POST(advisoryEvent(f, "edited"));
  assert.equal(response.status, 202);
  assert.match(await response.text(), /ignored repository_advisory action edited/);
  assert.equal((await advisoryJobs(f)).length, 0);
});

test("an advisory on an unconfigured repository creates no job", async () => {
  const f = fixture();
  await POST(
    request("installation", {
      action: "created",
      installation: { id: f.installationId, account: { login: "acme", id: 77 } },
      repositories: [{ id: f.repoId, full_name: f.fullName, private: false }],
    }),
  );

  const response = await POST(advisoryEvent(f, "reported"));
  assert.equal(await response.text(), "repository is not connected");
  assert.equal((await advisoryJobs(f)).length, 0);
});

test("a reported advisory without a ghsa_id is refused", async () => {
  const f = fixture();
  await connect(f);

  const response = await POST(
    request("repository_advisory", {
      action: "reported",
      repository_advisory: {},
      repository: { id: f.repoId, full_name: f.fullName },
      installation: { id: f.installationId },
    }),
  );
  assert.match(await response.text(), /no ghsa_id/);
  assert.equal((await advisoryJobs(f)).length, 0);
});

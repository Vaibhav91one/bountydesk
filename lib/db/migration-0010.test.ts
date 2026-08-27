import assert from "node:assert/strict";
import test, { after, before } from "node:test";

let schema: import("./testing").DisposableSchema;
let dbm: typeof import("./index");

before(async () => {
  const { createSchema } = await import("./testing");
  schema = await createSchema("mig0010");
  dbm = await import("./index");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

async function query<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await schema.admin.unsafe(text, params as never)) as unknown as T[];
}

async function seedApprovalPair() {
  const [report] = await query<{ id: string }>(
    `insert into "${schema.name}".report (channel, source_ref, title, body)
     values ('manual', $1, 'title', 'body') returning id`,
    [`manual:${crypto.randomUUID()}`],
  );
  const [session] = await query<{ id: string }>(
    `insert into "${schema.name}".agent_session
       (report_id, capability_token, session_id)
     values ($1, $2, $3) returning id`,
    [report.id, crypto.randomUUID(), `session-${crypto.randomUUID()}`],
  );

  const decisions: string[] = [];
  for (const revision of [1, 2]) {
    const [verdict] = await query<{ id: string }>(
      `insert into "${schema.name}".verdict
         (report_id, outcome, summary, payload, content_hash, revision)
       values ($1, 'ANALYSIS_ONLY', 'summary', 'payload', $2, $3) returning id`,
      [report.id, `hash-${revision}`, revision],
    );
    const [decision] = await query<{ id: string }>(
      `insert into "${schema.name}".approval_decision
         (verdict_id, reviewer, decision, payload_hash, thread_id, tool_call_id)
       values ($1, 'reviewer', 'APPROVED', $2, $3, $4) returning id`,
      [verdict.id, `hash-${revision}`, `thread-${revision}`, `call-${revision}`],
    );
    decisions.push(decision.id);
  }

  return { sessionId: session.id, decisions };
}

test("the TrueForge tables inherit the deny-by-default RLS posture", async () => {
  const rows = await schema.admin<{
    relname: string;
    relrowsecurity: boolean;
  }[]>`
    select relname, relrowsecurity
    from pg_class
    where relnamespace = ${schema.name}::regnamespace
      and relname in ('agent_session', 'approval_submission')
    order by relname
  `;

  assert.deepEqual(Array.from(rows), [
    { relname: "agent_session", relrowsecurity: true },
    { relname: "approval_submission", relrowsecurity: true },
  ]);
});

test("approval submissions are idempotent per immutable decision, not per session", async () => {
  const { sessionId, decisions } = await seedApprovalPair();

  for (const decisionId of decisions) {
    await query(
      `insert into "${schema.name}".approval_submission
         (agent_session_id, approval_decision_id)
       values ($1, $2)`,
      [sessionId, decisionId],
    );
  }

  await assert.rejects(
    query(
      `insert into "${schema.name}".approval_submission
         (agent_session_id, approval_decision_id)
       values ($1, $2)`,
      [sessionId, decisions[0]],
    ),
    /approval_submission_approval_decision_key/,
  );
});

test("an approval decision cannot carry a partial TrueForge call binding", async () => {
  const { sessionId } = await seedApprovalPair();
  const [session] = await query<{ report_id: string }>(
    `select report_id from "${schema.name}".agent_session where id = $1`,
    [sessionId],
  );
  const [verdict] = await query<{ id: string }>(
    `insert into "${schema.name}".verdict
       (report_id, outcome, summary, payload, content_hash, revision)
     values ($1, 'ANALYSIS_ONLY', 'summary', 'payload', 'hash-3', 3) returning id`,
    [session.report_id],
  );

  await assert.rejects(
    query(
      `insert into "${schema.name}".approval_decision
         (verdict_id, reviewer, decision, payload_hash, thread_id)
       values ($1, 'reviewer', 'APPROVED', 'hash-3', 'thread-3')`,
      [verdict.id],
    ),
    /approval_decision_call_all_or_none/,
  );
});

test("one TrueForge session cannot cross report boundaries", async () => {
  const { sessionId } = await seedApprovalPair();
  const [existing] = await query<{ session_id: string }>(
    `select session_id from "${schema.name}".agent_session where id = $1`,
    [sessionId],
  );
  const [otherReport] = await query<{ id: string }>(
    `insert into "${schema.name}".report (channel, source_ref, title, body)
     values ('manual', $1, 'other', 'body') returning id`,
    [`manual:${crypto.randomUUID()}`],
  );

  await assert.rejects(
    query(
      `insert into "${schema.name}".agent_session
         (report_id, capability_token, session_id)
       values ($1, $2, $3)`,
      [otherReport.id, crypto.randomUUID(), existing.session_id],
    ),
    /agent_session_session_id_key/,
  );
});

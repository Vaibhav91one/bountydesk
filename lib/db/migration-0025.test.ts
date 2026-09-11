import assert from "node:assert/strict";
import test, { after, before } from "node:test";

let schema: import("./testing").DisposableSchema;
let dbm: typeof import("./index");

before(async () => {
  const { createSchema } = await import("./testing");
  schema = await createSchema("mig0025");
  dbm = await import("./index");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

async function query<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await schema.admin.unsafe(text, params as never)) as unknown as T[];
}

async function seedReportAndVerdict() {
  const [report] = await query<{ id: string }>(
    `insert into "${schema.name}".report (channel, source_ref, title, body)
     values ('manual', $1, 'title', 'body') returning id`,
    [`manual:${crypto.randomUUID()}`],
  );
  const [verdict] = await query<{ id: string }>(
    `insert into "${schema.name}".verdict
       (report_id, outcome, summary, payload, content_hash, revision)
     values ($1, 'ANALYSIS_ONLY', 'summary', 'payload', 'hash-1', 1) returning id`,
    [report.id],
  );
  return { reportId: report.id, verdictId: verdict.id };
}

test("investigation and reviewer chat tables use deny-by-default RLS", async () => {
  const rows = await schema.admin<{
    relname: string;
    relrowsecurity: boolean;
  }[]>`
    select relname, relrowsecurity
    from pg_class
    where relnamespace = ${schema.name}::regnamespace
      and relname in (
        'investigation_run',
        'reviewer_chat_thread',
        'reviewer_chat_message',
        'verdict_supersession'
      )
    order by relname
  `;

  assert.deepEqual(Array.from(rows), [
    { relname: "investigation_run", relrowsecurity: true },
    { relname: "reviewer_chat_message", relrowsecurity: true },
    { relname: "reviewer_chat_thread", relrowsecurity: true },
    { relname: "verdict_supersession", relrowsecurity: true },
  ]);
});

test("investigation runs are numbered per report and retain parent and target bindings", async () => {
  const { reportId } = await seedReportAndVerdict();
  const [target] = await query<{ id: string }>(
    `insert into "${schema.name}".target_profile (name, image_digest)
     values ($1, $2) returning id`,
    [`target-${crypto.randomUUID()}`, `sha256:${"a".repeat(64)}`],
  );
  const [first] = await query<{ id: string }>(
    `insert into "${schema.name}".investigation_run
       (report_id, run_number, reason, status, target_profile_id, guidance_hash)
     values ($1, 1, 'INITIAL', 'DONE', $2, 'guidance-1') returning id`,
    [reportId, target.id],
  );
  const [second] = await query<{ id: string }>(
    `insert into "${schema.name}".investigation_run
       (report_id, run_number, parent_run_id, reason, status)
     values ($1, 2, $2, 'REVIEWER_GUIDANCE', 'PENDING') returning id`,
    [reportId, first.id],
  );

  assert.equal(
    (await query<{ parent_run_id: string; target_profile_id: string | null }>(
      `select parent_run_id, target_profile_id
       from "${schema.name}".investigation_run where id = $1`,
      [second.id],
    ))[0].parent_run_id,
    first.id,
  );
  assert.equal(
    (await query<{ target_profile_id: string }>(
      `select target_profile_id from "${schema.name}".investigation_run where id = $1`,
      [first.id],
    ))[0].target_profile_id,
    target.id,
  );

  await assert.rejects(
    query(
      `insert into "${schema.name}".investigation_run
         (report_id, run_number, reason, status)
       values ($1, 1, 'INITIAL', 'PENDING')`,
      [reportId],
    ),
    /investigation_run_report_run_number_key/,
  );
});

test("one active chat thread exists for a report and verdict", async () => {
  const { reportId, verdictId } = await seedReportAndVerdict();
  const [thread] = await query<{ id: string }>(
    `insert into "${schema.name}".reviewer_chat_thread
       (report_id, verdict_id, verdict_revision, verdict_content_hash, reviewer_id, status)
     values ($1, $2, 1, 'hash-1', 'reviewer-1', 'OPEN') returning id`,
    [reportId, verdictId],
  );

  await assert.rejects(
    query(
      `insert into "${schema.name}".reviewer_chat_thread
         (report_id, verdict_id, verdict_revision, verdict_content_hash, reviewer_id, status)
       values ($1, $2, 1, 'hash-1', 'reviewer-2', 'RUNNING')`,
      [reportId, verdictId],
    ),
    /reviewer_chat_thread_active_verdict_key/,
  );

  await query(
    `update "${schema.name}".reviewer_chat_thread set status = 'DONE' where id = $1`,
    [thread.id],
  );
  await query(
    `insert into "${schema.name}".reviewer_chat_thread
       (report_id, verdict_id, verdict_revision, verdict_content_hash, reviewer_id, status)
     values ($1, $2, 1, 'hash-1', 'reviewer-2', 'OPEN')`,
    [reportId, verdictId],
  );
});

test("chat and supersession links cannot cross report ownership boundaries", async () => {
  const first = await seedReportAndVerdict();
  const second = await seedReportAndVerdict();
  const [run] = await query<{ id: string }>(
    `insert into "${schema.name}".investigation_run
       (report_id, run_number, reason, status)
     values ($1, 1, 'REVIEWER_GUIDANCE', 'PENDING') returning id`,
    [first.reportId],
  );

  await assert.rejects(
    query(
      `insert into "${schema.name}".reviewer_chat_thread
         (report_id, verdict_id, verdict_revision, verdict_content_hash, reviewer_id)
       values ($1, $2, 1, 'hash-1', 'reviewer-1')`,
      [first.reportId, second.verdictId],
    ),
    /reviewer_chat_thread_report_verdict_fk/,
  );
  await assert.rejects(
    query(
      `insert into "${schema.name}".verdict_supersession
         (report_id, old_verdict_id, superseded_by_run_id, reason, actor)
       values ($1, $2, $3, 'cross-report', 'reviewer-1')`,
      [second.reportId, first.verdictId, run.id],
    ),
    /verdict_supersession_report_verdict_fk/,
  );
});

test("reviewer chat messages are bounded, idempotent per thread, and append-only", async () => {
  const { reportId } = await seedReportAndVerdict();
  const [thread] = await query<{ id: string }>(
    `insert into "${schema.name}".reviewer_chat_thread
       (report_id, reviewer_id, status)
     values ($1, 'reviewer-1', 'OPEN') returning id`,
    [reportId],
  );
  const [message] = await query<{ id: string }>(
    `insert into "${schema.name}".reviewer_chat_message
       (thread_id, client_request_id, sender, body, body_hash)
     values ($1, 'request-1', 'REVIEWER', 'Please recheck the input validation.', 'body-hash')
     returning id`,
    [thread.id],
  );

  await assert.rejects(
    query(
      `insert into "${schema.name}".reviewer_chat_message
         (thread_id, client_request_id, sender, body, body_hash)
       values ($1, 'request-1', 'REVIEWER', 'retry', 'body-hash-2')`,
      [thread.id],
    ),
    /reviewer_chat_message_thread_request_key/,
  );
  await assert.rejects(
    query(
      `insert into "${schema.name}".reviewer_chat_message
         (thread_id, client_request_id, sender, body, body_hash)
       values ($1, 'request-empty', 'SYSTEM', '', 'body-hash')`,
      [thread.id],
    ),
    /reviewer_chat_message_body_length_check/,
  );
  await assert.rejects(
    query(
      `update "${schema.name}".reviewer_chat_message set body = 'edited' where id = $1`,
      [message.id],
    ),
    /reviewer_chat_message is append-only/,
  );
  await assert.rejects(
    query(`delete from "${schema.name}".reviewer_chat_message where id = $1`, [message.id]),
    /reviewer_chat_message is append-only/,
  );
});

test("verdict supersession is immutable and one-to-one", async () => {
  const { reportId, verdictId } = await seedReportAndVerdict();
  const [run] = await query<{ id: string }>(
    `insert into "${schema.name}".investigation_run
       (report_id, run_number, reason, status)
     values ($1, 1, 'REVIEWER_GUIDANCE', 'PENDING') returning id`,
    [reportId],
  );
  const [supersession] = await query<{ id: string }>(
    `insert into "${schema.name}".verdict_supersession
       (report_id, old_verdict_id, superseded_by_run_id, reason, actor, guidance_hash)
     values ($1, $2, $3, 'reviewer requested another investigation', 'reviewer-1', 'guidance-1')
     returning id`,
    [reportId, verdictId, run.id],
  );

  await assert.rejects(
    query(
      `update "${schema.name}".verdict_supersession set reason = 'changed' where id = $1`,
      [supersession.id],
    ),
    /verdict_supersession is append-only/,
  );
  await assert.rejects(
    query(
      `insert into "${schema.name}".verdict_supersession
         (report_id, old_verdict_id, superseded_by_run_id, reason, actor)
       values ($1, $2, $3, 'duplicate', 'reviewer-1')`,
      [reportId, verdictId, run.id],
    ),
    /verdict_supersession_old_verdict_id_key/,
  );
});

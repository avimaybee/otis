/**
 * R09 review probes against the current implementation, on isolated workerd D1.
 * Expectations express the required behavior; failures are audit evidence.
 * No provider, live service, application source edit or remote data is used.
 */
import { beforeAll, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../../apps/worker/test/migrations.js';
import { acceptWebMessage, createChat } from '../../apps/worker/src/inbox/repository.js';
import { executeAgentTool } from '../../apps/worker/src/agent/repository.js';
import { resumeRun } from '../../apps/worker/src/actor/dispatch.js';
import { DEFAULT_COMMAND_HANDLERS, executeLedgerCommand, getFieldProjectionState } from '../../packages/ledger/src/index.js';

interface Fixture { ws: string; owner: string; chatId: string; entityId: string }
type Field = { field_name: string; value: unknown; provenance?: 'stated' | 'inferred' };

beforeAll(async () => { await applyMigrations(env.DB); });

async function fixture(suffix: string): Promise<Fixture> {
  const ws = `ws-review-${suffix}`;
  const owner = `usr-review-${suffix}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(owner, owner, `${suffix}@review.test`, suffix, now, now).run();
  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, ?, ?)`,
  ).bind(ws, suffix, owner, now, now).run();
  await env.DB.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?, ?)`,
  ).bind(ws, owner, now, now, now).run();
  const chatId = (await createChat(env.DB, { workspaceId: ws, authorUserId: owner, title: suffix })).id;
  const entityId = `ent-review-${suffix}`;
  await env.DB.prepare(
    `INSERT INTO entities (id, workspace_id, name, kind, status, created_at, updated_at)
     VALUES (?, ?, ?, 'lead', 'new', ?, ?)`,
  ).bind(entityId, ws, suffix, now, now).run();
  return { ws, owner, chatId, entityId };
}

async function input(f: Fixture, suffix: string, text: string) {
  const accepted = await acceptWebMessage(env.DB, {
    workspaceId: f.ws, chatId: f.chatId, userId: f.owner,
    clientMessageId: `cm-review-${suffix}`, text,
  });
  const row = await env.DB.prepare(
    `SELECT id FROM messages_in WHERE workspace_id=? AND external_id=?`,
  ).bind(f.ws, `cm-review-${suffix}`).first<{ id: string }>();
  if (!row) throw new Error('Missing synthetic source');
  return { runId: accepted.run_id, messageId: row.id };
}

async function field(f: Fixture, name: string) {
  return (await env.DB.prepare(
    `SELECT value_text FROM entity_state WHERE workspace_id=? AND entity_id=? AND field_name=?`,
  ).bind(f.ws, f.entityId, name).first<{ value_text: string | null }>())?.value_text ?? null;
}

async function status(f: Fixture) {
  return (await env.DB.prepare(`SELECT status FROM entities WHERE workspace_id=? AND id=?`)
    .bind(f.ws, f.entityId).first<{ status: string }>())?.status;
}

async function legacy(f: Fixture, suffix: string, fields: Field[]) {
  const facts = fields.filter((item) => item.field_name !== 'status')
    .map((item) => `${item.field_name} is ${String(item.value)}.`).join(' ');
  const src = await input(f, `${suffix}-source`, `${facts} Lead seems warm.`);
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE agent_runs SET status='waiting_for_input' WHERE id=?`)
    .bind(src.runId).run();
  const clarId = `clar-review-${suffix}`;
  const payload = JSON.stringify({ command: 'set_fields', params: { entity_id: f.entityId, fields } });
  await env.DB.prepare(
    `INSERT INTO pending_clarifications
     (id, workspace_id, chat_id, run_id, source_message_id, requester_user_id, question,
      intended_operation, missing_fields, candidates_json, operation_payload_json,
      source_revision, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'Mark warm?', 'set_fields', ?, ?, ?, 0, 'pending', ?, ?)`,
  ).bind(clarId, f.ws, f.chatId, src.runId, src.messageId, f.owner,
    JSON.stringify(['status_confirmation']), JSON.stringify(['confirm', 'cancel']), payload, now, now).run();
  return { ...src, clarId, payload };
}

async function reply(f: Fixture, runId: string, clarId: string, suffix: string, text: string, db = env.DB) {
  const answer = await input(f, suffix, text);
  return resumeRun(db, {
    workspaceId: f.ws, runId,
    answer: { messageId: answer.messageId, text, clarificationId: clarId },
  });
}

it('mixed receipt replay still parks the existing pending question', async () => {
  const f = await fixture('mixed');
  const src = await input(f, 'mixed-source', 'Phone is 123; lead seems warm.');
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE workspaces SET lease_owner='review-holder', lease_attempt_id='review-holder', lease_fence=1, lease_expires_at=? WHERE id=?`,
  ).bind(new Date(Date.now() + 3_600_000).toISOString(), f.ws).run();
  await env.DB.prepare(`UPDATE agent_runs SET status='running', attempt_id='review-holder', lease_fence=1, updated_at=? WHERE id=?`)
    .bind(now, src.runId).run();
  const params = {
    db: env.DB, workspaceId: f.ws, actorUserId: f.owner, runId: src.runId,
    chatId: f.chatId, fence: 1, sourceMessageId: src.messageId, sourceText: 'Phone is 123; lead seems warm.',
    actionId: 'act-review-mixed', expectedBusinessRevision: 0, toolName: 'set_fields',
    toolArgs: { entity_id: f.entityId, fields: [
      { field_name: 'phone', value: '123' }, { field_name: 'status', value: 'warm' },
    ] },
  };
  const first = await executeAgentTool(params);
  expect(first.status).toBe('needs_clarification');
  const second = await executeAgentTool(params);
  const q = await env.DB.prepare(`SELECT status FROM pending_clarifications WHERE run_id=?`)
    .bind(src.runId).first<{ status: string }>();
  console.log('R09_REVIEW mixed_retry', { first: first.status, retry: second.status, question: q?.status });
  expect(second.status).toBe('needs_clarification');
});

it('legacy decline preserves independent phone facts', async () => {
  const f = await fixture('decline');
  const l = await legacy(f, 'decline', [
    { field_name: 'phone', value: '123', provenance: 'stated' },
    { field_name: 'status', value: 'warm', provenance: 'inferred' },
  ]);
  const result = await reply(f, l.runId, l.clarId, 'decline-answer', 'cancel');
  console.log('R09_REVIEW legacy_decline', { resumed: result.resumed, phone: await field(f, 'phone'), status: await status(f) });
  expect(result.resumed).toBe(true);
  expect(await status(f)).toBe('new');
  expect(await field(f, 'phone')).toBe('123');
});

it('failed legacy confirmation cannot turn a later decline into approval', async () => {
  const f = await fixture('failed-confirm');
  const l = await legacy(f, 'failed-confirm', [{ field_name: 'status', value: 'warm', provenance: 'inferred' }]);
  let injected = false;
  const failingDb = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'batch') return async (statements: D1PreparedStatement[]) => {
        // The hydration batch has 3 SELECTs; fail the actual write batch with
        // a real D1 SQL error after its statements, proving rollback.
        if (!injected && statements.length > 3) {
          injected = true;
          return target.batch([...statements, target.prepare('SELECT * FROM missing_r09_review_table')]);
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const failed = await reply(f, l.runId, l.clarId, 'failed-confirm-answer', 'confirm', failingDb)
    .catch((error: unknown) => {
      expect(String(error)).toContain('missing_r09_review_table');
      return { resumed: false };
    });
  expect(injected).toBe(true);
  expect(failed.resumed).toBe(false);
  expect(await status(f)).toBe('new');
  const stored = await env.DB.prepare(`SELECT operation_payload_json, missing_fields FROM pending_clarifications WHERE id=?`)
    .bind(l.clarId).first<{ operation_payload_json: string; missing_fields: string }>();
  const cancelled = await reply(f, l.runId, l.clarId, 'failed-confirm-decline', 'cancel');
  console.log('R09_REVIEW failed_then_decline', {
    failed: failed.resumed, storedCommand: JSON.parse(stored!.operation_payload_json).command_name,
    storedMissing: stored!.missing_fields, decline: cancelled.resumed, status: await status(f),
  });
  expect(await status(f)).toBe('new');
  expect(stored?.operation_payload_json).toBe(l.payload);
});

it('partial legacy replay uses the revision from an actual committed child', async () => {
  const f = await fixture('partial');
  const src = await input(f, 'partial-source', 'Phone is 123; language is fa.');
  const first = await executeLedgerCommand(env.DB, {
    workspace_id: f.ws, actor: { kind: 'member', user_id: f.owner }, membership_revision: 1,
    action_id: 'act-review-partial_f0', request_id: 'review-partial', source_message_id: src.messageId,
    expected_business_revision: 0,
  }, 'set_field', { entity_id: f.entityId, field_name: 'phone', value: '123', provenance: 'stated' },
  DEFAULT_COMMAND_HANDLERS['set_field']!);
  expect(first.status).toBe('applied');
  const result = await executeAgentTool({
    db: env.DB, workspaceId: f.ws, actorUserId: f.owner,
    actionId: 'act-review-partial', sourceMessageId: src.messageId,
    expectedBusinessRevision: 0, toolName: 'set_fields',
    toolArgs: { entity_id: f.entityId, fields: [
      { field_name: 'phone', value: '123' }, { field_name: 'preferred_language', value: 'fa' },
    ] },
  });
  console.log('R09_REVIEW partial_real_commit', { first: first.status, firstRevision: first.committed_revision, retry: result.status, error: result.error?.code });
  expect(result.status).toBe('applied');
  expect(await field(f, 'preferred_language')).toBe('fa');
});

it('alias hydration does not scan unrelated workspace aliases', async () => {
  const samples: { aliases: number; read: number; plan: string[] }[] = [];
  for (const count of [10, 1_000]) {
    const f = await fixture(`aliases-${count}`);
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < count; i++) {
      const otherId = `ent-alias-${count}-${i}`;
      statements.push(env.DB.prepare(
        `INSERT INTO entities (id, workspace_id, name, kind, status, created_at, updated_at)
         VALUES (?, ?, ?, 'lead', 'new', ?, ?)`,
      ).bind(otherId, f.ws, `Other ${i}`, '2026-10-08T00:00:00Z', '2026-10-08T00:00:00Z'));
      statements.push(env.DB.prepare(
        `INSERT INTO entity_aliases (id, workspace_id, entity_id, alias, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind(`alias-${count}-${i}`, f.ws, otherId, `Alias ${i}`, '2026-10-08T00:00:00Z'));
    }
    for (let offset = 0; offset < statements.length; offset += 40) await env.DB.batch(statements.slice(offset, offset + 40));
    let aliasRead = -1;
    const measuredDb = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch') return async (queries: D1PreparedStatement[]) => {
          const results = await target.batch(queries);
          aliasRead = results[1].meta.rows_read;
          return results;
        };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await getFieldProjectionState(measuredDb, f.ws, f.entityId, ['phone']);
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM entity_aliases WHERE workspace_id=? AND entity_id=?`,
    ).bind(f.ws, f.entityId).all<{ detail: string }>();
    samples.push({ aliases: count, read: aliasRead, plan: plan.results.map((r) => r.detail) });
  }
  console.log('R09_REVIEW alias_scan', samples);
  expect(samples[1].read).toBeLessThanOrEqual(samples[0].read + 3);
});

it('legacy decline rechecks membership in the committing transaction', async () => {
  const f = await fixture('revoked-decline');
  const l = await legacy(f, 'revoked-decline', [{ field_name: 'status', value: 'warm', provenance: 'inferred' }]);
  const answer = await input(f, 'revoked-decline-answer', 'cancel');
  const result = await resumeRun(env.DB, {
    workspaceId: f.ws, runId: l.runId,
    answer: { messageId: answer.messageId, text: 'cancel', clarificationId: l.clarId },
    testHooks: { afterPrecheck: async () => {
      await env.DB.prepare(`DELETE FROM workspace_users WHERE workspace_id=? AND user_id=?`)
        .bind(f.ws, f.owner).run();
    } },
  });
  const q = await env.DB.prepare(`SELECT status FROM pending_clarifications WHERE id=?`)
    .bind(l.clarId).first<{ status: string }>();
  console.log('R09_REVIEW revoked_decline', { resumed: result.resumed, question: q?.status });
  expect(q?.status).toBe('pending');
  expect(result.resumed).toBe(false);
});

it('question-only replay does not reopen an already-declined question', async () => {
  const f = await fixture('declined-replay');
  const src = await input(f, 'declined-replay-source', 'Lead seems warm.');
  await env.DB.prepare(
    `UPDATE workspaces SET lease_owner='review-holder', lease_attempt_id='review-holder', lease_fence=1, lease_expires_at=? WHERE id=?`,
  ).bind(new Date(Date.now() + 3_600_000).toISOString(), f.ws).run();
  await env.DB.prepare(`UPDATE agent_runs SET status='running', attempt_id='review-holder', lease_fence=1 WHERE id=?`)
    .bind(src.runId).run();
  const params = {
    db: env.DB, workspaceId: f.ws, actorUserId: f.owner, sourceMessageId: src.messageId,
    runId: src.runId, chatId: f.chatId, fence: 1, sourceText: 'Lead seems warm.',
    actionId: 'act-review-declined-replay', expectedBusinessRevision: 0, toolName: 'set_fields',
    toolArgs: { entity_id: f.entityId, fields: [{ field_name: 'status', value: 'warm' }] },
  };
  const first = await executeAgentTool(params);
  expect(first.status).toBe('needs_clarification');
  const q = await env.DB.prepare(`SELECT id FROM pending_clarifications WHERE run_id=? AND status='pending'`)
    .bind(src.runId).first<{ id: string }>();
  expect(q).not.toBeNull();
  await env.DB.prepare(`UPDATE agent_runs SET status='waiting_for_input' WHERE id=?`).bind(src.runId).run();
  const declined = await reply(f, src.runId, q!.id, 'declined-replay-answer', 'cancel');
  expect(declined.resumed).toBe(true);
  const qStatus = await env.DB.prepare(`SELECT status FROM pending_clarifications WHERE id=?`)
    .bind(q!.id).first<{ status: string }>();
  expect(qStatus?.status).toBe('cancelled');
  const replay = await executeAgentTool(params);
  console.log('R09_REVIEW question_after_decline', { first: first.status, question: qStatus?.status, replay: replay.status });
  expect(replay.status).toBe('already_applied');
});

it('the new parent commit rolls back facts and question on late membership removal', async () => {
  const f = await fixture('guard-control');
  const src = await input(f, 'guard-control-source', 'Phone is 123; lead seems warm.');
  await env.DB.prepare(
    `UPDATE workspaces SET lease_owner='review-holder', lease_attempt_id='review-holder', lease_fence=1, lease_expires_at=? WHERE id=?`,
  ).bind(new Date(Date.now() + 3_600_000).toISOString(), f.ws).run();
  await env.DB.prepare(`UPDATE agent_runs SET status='running', attempt_id='review-holder', lease_fence=1 WHERE id=?`)
    .bind(src.runId).run();
  let removed = false;
  const raceDb = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (!removed && statements.length > 3) {
          removed = true;
          await target.prepare(`DELETE FROM workspace_users WHERE workspace_id=? AND user_id=?`)
            .bind(f.ws, f.owner).run();
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const result = await executeAgentTool({
    db: raceDb, workspaceId: f.ws, actorUserId: f.owner, sourceMessageId: src.messageId,
    runId: src.runId, chatId: f.chatId, fence: 1, sourceText: 'Phone is 123; lead seems warm.',
    actionId: 'act-review-guard-control', expectedBusinessRevision: 0, toolName: 'set_fields',
    toolArgs: { entity_id: f.entityId, fields: [
      { field_name: 'phone', value: '123' }, { field_name: 'status', value: 'warm' },
    ] },
  });
  expect(removed).toBe(true);
  expect(result.status).toBe('rejected');
  expect(await field(f, 'phone')).toBeNull();
  expect(await status(f)).toBe('new');
  for (const table of ['events', 'action_receipts', 'pending_clarifications']) {
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id=?`)
      .bind(f.ws).first<{ n: number }>();
    expect(count?.n).toBe(0);
  }
});

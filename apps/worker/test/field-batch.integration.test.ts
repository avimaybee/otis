import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
import { AUTH_BOUNDS } from '@otis/contracts';
import { acceptWebMessage, createChat } from '../src/inbox/repository.js';
import { dispatchOutboxItem, resumeRun } from '../src/actor/dispatch.js';
import { AgentHandler } from '../src/agent/handler.js';
import { executeAgentTool } from '../src/agent/repository.js';
import { FakeProviderAdapter } from '@otis/agent';
import { resumePendingClarification } from '@otis/ledger';
import { sha256 } from '@otis/identity';

/**
 * Atomic field batches (R09 prerequisite) on workerd D1: one validated
 * transaction, one parent receipt and one business revision per set_fields
 * request; ready facts save while only an uncertain status parks; confirm /
 * decline / ambiguous answers behave; Undo cancels the parked intent; legacy
 * per-field receipts complete without reapplying; retries charge nothing.
 */

const CSRF = {
  origin: 'http://localhost',
  [AUTH_BOUNDS.CSRF_HEADER]: '1',
  'Content-Type': 'application/json',
};

const testLimits = { maxDailyActions: 50, maxRoundsPerRun: 10 };

interface Shop {
  ws: string;
  owner: string;
  cookie: string;
  chatId: string;
}

async function makeShop(suffix: string): Promise<Shop> {
  const ws = `ws-fbatch-${suffix}`;
  const owner = `usr_fbatch_${suffix}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(owner, `fb_${suffix}`, `${suffix}@fb.test`, `Owner ${suffix}`, now, now).run();
  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, ?, ?)`,
  ).bind(ws, `Batch ${suffix}`, owner, now, now).run();
  await env.DB.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?, ?)`,
  ).bind(ws, owner, now, now, now).run();
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  ).bind(`sess_fb_${suffix}`, await sha256(`tok_fb_${suffix}`), owner, now, expiresAt, now).run();
  const chatId = (await createChat(env.DB, { workspaceId: ws, authorUserId: owner, title: `Batch ${suffix}` })).id;
  return { ws, owner, cookie: `${AUTH_BOUNDS.COOKIE_NAME}=tok_fb_${suffix}`, chatId };
}

async function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('Cookie', init.cookie);
  return SELF.fetch(`http://localhost${path}`, { ...init, headers });
}

async function outboxIdForRun(runId: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT id FROM outbox WHERE json_extract(payload_json, '$.run_id') = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(runId).first<{ id: string }>();
  if (!row) throw new Error(`outbox for run ${runId} missing`);
  return row.id;
}

async function revision(ws: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT business_revision FROM workspaces WHERE id = ?`)
    .bind(ws).first<{ business_revision: number }>();
  return Number(row?.business_revision ?? -1);
}

async function runTurn(
  shop: Shop,
  clientMessageId: string,
  text: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scripts: any[],
): Promise<{ runId: string; status: string }> {
  const accepted = await acceptWebMessage(env.DB, {
    workspaceId: shop.ws,
    chatId: shop.chatId,
    userId: shop.owner,
    clientMessageId,
    text,
  });
  const handler = new AgentHandler({
    providerAdapter: new FakeProviderAdapter({ scripts }),
    limits: testLimits,
    maxRoundsPerSlice: 4,
  });
  const res = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), shop.ws, { handler });
  return { runId: accepted.run_id, status: res.status };
}

async function seedEntity(shop: Shop, suffix: string, name: string): Promise<string> {
  const res = await runTurn(shop, `cm-seed-${suffix}`, `Record lead ${name}`, [
    { kind: 'tool_calls', calls: [{ callId: 'c_up', name: 'upsert_entity', args: { name } }] },
    { kind: 'text', text: `Recorded ${name}.` },
  ]);
  expect(res.status).toBe('completed');
  const row = await env.DB.prepare(`SELECT id FROM entities WHERE workspace_id = ? AND name = ?`)
    .bind(shop.ws, name).first<{ id: string }>();
  if (!row) throw new Error(`seed entity ${name} missing`);
  return row.id;
}

async function pendingQuestion(shop: Shop, runId: string) {
  return env.DB.prepare(
    `SELECT id, question, intended_operation, operation_payload_json, source_revision, status
     FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`,
  ).bind(runId).first<{
    id: string; question: string; intended_operation: string;
    operation_payload_json: string; source_revision: number; status: string;
  }>();
}

async function answerQuestion(shop: Shop, clarId: string, text: string, clientMessageId: string): Promise<Response> {
  return call(`/api/workspaces/${shop.ws}/clarifications/${clarId}/reply`, {
    method: 'POST',
    cookie: shop.cookie,
    headers: CSRF,
    body: JSON.stringify({ text, client_message_id: clientMessageId }),
  });
}

async function inboundIdForClientMessage(shop: Shop, clientMessageId: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT id FROM messages_in WHERE workspace_id = ? AND chat_id = ? AND external_id = ?`,
  ).bind(shop.ws, shop.chatId, clientMessageId).first<{ id: string }>();
  if (!row) throw new Error(`messages_in for ${clientMessageId} missing`);
  return row.id;
}

async function fieldValue(shop: Shop, entityId: string, fieldName: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT value_text FROM entity_state WHERE workspace_id = ? AND entity_id = ? AND field_name = ?`,
  ).bind(shop.ws, entityId, fieldName).first<{ value_text: string | null }>();
  return row?.value_text ?? null;
}

async function entityStatus(shop: Shop, entityId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT status FROM entities WHERE id = ?`)
    .bind(entityId).first<{ status: string }>();
  return String(row?.status ?? '');
}

async function eventCount(shop: Shop): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE workspace_id = ?`)
    .bind(shop.ws).first<{ n: number }>();
  return Number(row?.n ?? -1);
}

let shopA!: Shop;
let shopB!: Shop;
let shopC!: Shop;
let shopD!: Shop;

beforeAll(async () => {
  await applyMigrations(env.DB);
  shopA = await makeShop('a');
  shopB = await makeShop('b');
  shopC = await makeShop('c');
  shopD = await makeShop('d');
});

describe('mixed batch: ready facts save, uncertain status parks', () => {
  it('commits phone in one revision and asks only about status', async () => {
    const entityId = await seedEntity(shopA, 'm1', 'Mixed Client');
    const revBefore = await revision(shopA.ws);
    const eventsBefore = await eventCount(shopA);

    const turn = await runTurn(shopA, 'cm-mix-1', 'Log call with Mixed Client, they seem warm now', [
      {
        kind: 'tool_calls',
        calls: [{
          callId: 'c_sf',
          name: 'set_fields',
          args: {
            entity_id: entityId,
            fields: [
              { field_name: 'phone', value: '+40123456789' },
              { field_name: 'status', value: 'warm', provenance: 'inferred' },
            ],
          },
        }],
      },
    ]);
    expect(turn.status).toBe('waiting_for_input');

    // One revision for the whole batch, one fact event; status untouched.
    expect(await revision(shopA.ws)).toBe(revBefore + 1);
    expect(await eventCount(shopA)).toBe(eventsBefore + 1);
    expect(await fieldValue(shopA, entityId, 'phone')).toContain('40123456789');
    expect(await entityStatus(shopA, entityId)).toBe('new');

    const clar = await pendingQuestion(shopA, turn.runId);
    expect(clar?.question).toContain('warm');
    expect(clar?.question).toContain('phone');
    const op = JSON.parse(clar!.operation_payload_json) as { command_name: string; args: Record<string, unknown> };
    expect(op.command_name).toBe('set_field');
    expect(op.args).toMatchObject({ entity_id: entityId, field_name: 'status', value: 'warm' });
    expect(op.args).not.toHaveProperty('phone');

    // Parent receipt is applied with the clarification attached.
    const receipt = await env.DB.prepare(
      `SELECT result_status, result_json, committed_revision FROM action_receipts
       WHERE workspace_id = ? AND command_name = 'set_fields' ORDER BY created_at DESC LIMIT 1`,
    ).bind(shopA.ws).first<{ result_status: string; result_json: string; committed_revision: number }>();
    expect(receipt?.result_status).toBe('applied');
    expect(JSON.parse(receipt!.result_json)).toMatchObject({
      data: { applied_fields: ['phone'], pending_field: { field_name: 'status', value: 'warm' } },
    });
    expect(Number(receipt?.committed_revision)).toBe(revBefore + 1);
  });

  it('applies the parked status on confirm with one more revision', async () => {
    const turn = await runTurn(shopA, 'cm-mix-2', 'Log visit with Mixed Client, they seem warm', [
      {
        kind: 'tool_calls',
        calls: [{
          callId: 'c_sf2',
          name: 'set_fields',
          args: {
            entity_id: (await env.DB.prepare(`SELECT id FROM entities WHERE workspace_id = ? AND name = ?`)
              .bind(shopA.ws, 'Mixed Client').first<{ id: string }>())!.id,
            fields: [{ field_name: 'status', value: 'warm', provenance: 'inferred' }],
          },
        }],
      },
    ]);
    const revBefore = await revision(shopA.ws);
    const clar = await pendingQuestion(shopA, turn.runId);
    const reply = await answerQuestion(shopA, clar!.id, 'confirm', 'cm-mix-confirm-1');
    expect(reply.status).toBe(202);
    expect(await entityStatus(shopA, (await env.DB.prepare(`SELECT id FROM entities WHERE workspace_id = ? AND name = ?`)
      .bind(shopA.ws, 'Mixed Client').first<{ id: string }>())!.id)).toBe('warm');
    expect(await revision(shopA.ws)).toBe(revBefore + 1);

    // Answering the resolved question again is a clean replay, not a rewrite.
    const again = await answerQuestion(shopA, clar!.id, 'confirm', 'cm-mix-confirm-2');
    expect([202, 409]).toContain(again.status);
    expect(await revision(shopA.ws)).toBe(revBefore + 1);
  });

  it('declines cleanly and leaves ambiguous answers pending', async () => {
    const entityId = await seedEntity(shopA, 'm3', 'Decline Client');
    const turn = await runTurn(shopA, 'cm-mix-3', 'Decline Client seems warm', [
      {
        kind: 'tool_calls',
        calls: [{
          callId: 'c_sf3',
          name: 'set_fields',
          args: {
            entity_id: entityId,
            fields: [
              { field_name: 'phone', value: '+40000000001' },
              { field_name: 'status', value: 'warm', provenance: 'inferred' },
            ],
          },
        }],
      },
    ]);
    const clar = await pendingQuestion(shopA, turn.runId);

    const vague = await answerQuestion(shopA, clar!.id, 'maybe later', 'cm-mix-vague-1');
    expect(vague.status).toBe(422);
    expect((await pendingQuestion(shopA, turn.runId))?.status).toBe('pending');

    const no = await answerQuestion(shopA, clar!.id, 'cancel', 'cm-mix-no-1');
    expect(no.status).toBe(202);
    expect(await entityStatus(shopA, entityId)).toBe('new');
    expect(await fieldValue(shopA, entityId, 'phone')).toContain('40000000001');
    const row = await env.DB.prepare(`SELECT status FROM pending_clarifications WHERE id = ?`)
      .bind(clar!.id).first<{ status: string }>();
    expect(row?.status).toBe('cancelled');
  });
});

describe('question-only, explicit intent and direct batch semantics', () => {
  it('parks a lone uncertain status without committing or charging revision', async () => {
    const entityId = await seedEntity(shopB, 'q1', 'Question Client');
    const revBefore = await revision(shopB.ws);
    const eventsBefore = await eventCount(shopB);
    const turn = await runTurn(shopB, 'cm-q-1', 'Question Client seems hot', [
      {
        kind: 'tool_calls',
        calls: [{
          callId: 'c_sfq',
          name: 'set_fields',
          args: { entity_id: entityId, fields: [{ field_name: 'status', value: 'hot', provenance: 'inferred' }] },
        }],
      },
    ]);
    expect(turn.status).toBe('waiting_for_input');
    expect(await revision(shopB.ws)).toBe(revBefore);
    expect(await eventCount(shopB)).toBe(eventsBefore);
    const clar = await pendingQuestion(shopB, turn.runId);
    expect(clar?.question).toContain('hot');

    const reply = await answerQuestion(shopB, clar!.id, 'yes', 'cm-q-yes-1');
    expect(reply.status).toBe(202);
    expect(await entityStatus(shopB, entityId)).toBe('hot');
  });

  it('saves an explicitly instructed status directly', async () => {
    const entityId = await seedEntity(shopB, 'q2', 'Explicit Client');
    const turn = await runTurn(shopB, 'cm-q-2', 'Mark Explicit Client warm', [
      {
        kind: 'tool_calls',
        calls: [{
          callId: 'c_sfe',
          name: 'set_fields',
          args: {
            entity_id: entityId,
            fields: [
              { field_name: 'phone', value: '+40222222222' },
              { field_name: 'status', value: 'warm' },
            ],
          },
        }],
      },
      { kind: 'text', text: 'Done.' },
    ]);
    expect(turn.status).toBe('completed');
    expect(await entityStatus(shopB, entityId)).toBe('warm');
    expect(await fieldValue(shopB, entityId, 'phone')).toContain('40222222222');
  });

  it('retries the same action without new business effects', async () => {
    const entityId = await seedEntity(shopC, 'r1', 'Retry Client');
    const rev = await revision(shopC.ws);
    const src = await acceptWebMessage(env.DB, {
      workspaceId: shopC.ws,
      chatId: shopC.chatId,
      userId: shopC.owner,
      clientMessageId: 'cm-retry-src-1',
      text: 'Update Retry Client phone',
    });
    const srcInboundId = await inboundIdForClientMessage(shopC, 'cm-retry-src-1');
    void src;
    const params = {
      db: env.DB,
      workspaceId: shopC.ws,
      actorUserId: shopC.owner,
      actionId: 'act-retry-batch-1',
      sourceMessageId: srcInboundId,
      toolName: 'set_fields',
      toolArgs: { entity_id: entityId, fields: [{ field_name: 'phone', value: '+40333333333' }] },
      expectedBusinessRevision: rev,
    };
    const first = await executeAgentTool(params);
    expect(first.status).toBe('applied');
    const second = await executeAgentTool(params);
    expect(second.status).toBe('already_applied');
    expect(await revision(shopC.ws)).toBe(rev + 1);
    expect(await fieldValue(shopC, entityId, 'phone')).toContain('40333333333');
  });

  it('charges the trusted ready cost once and rejects over-capacity batches atomically', async () => {
    const shop = await makeShop('e');
    const entityId = await seedEntity(shop, 'r2', 'Quota Client');
    // Seed charged 1: with limit 2, a two-field batch (cost 2) exceeds the
    // remaining capacity while a single field fits exactly.
    const rev = await revision(shop.ws);
    const eventsBefore = await eventCount(shop);
    const src = await acceptWebMessage(env.DB, {
      workspaceId: shop.ws,
      chatId: shop.chatId,
      userId: shop.owner,
      clientMessageId: 'cm-quota-src-1',
      text: 'Update Quota Client details',
    });
    void src;
    const srcInboundId = await inboundIdForClientMessage(shop, 'cm-quota-src-1');
    const over = await executeAgentTool({
      db: env.DB,
      workspaceId: shop.ws,
      actorUserId: shop.owner,
      actionId: 'act-quota-over-1',
      sourceMessageId: srcInboundId,
      toolName: 'set_fields',
      toolArgs: {
        entity_id: entityId,
        fields: [
          { field_name: 'phone', value: '+40444444444' },
          { field_name: 'preferred_language', value: 'hu' },
        ],
      },
      expectedBusinessRevision: rev,
      maxDailyActions: 2,
    });
    expect(over.status).toBe('rejected');
    expect(over.error?.code).toBe('daily_action_limit_exceeded');
    expect(await revision(shop.ws)).toBe(rev);
    expect(await eventCount(shop)).toBe(eventsBefore);
    expect(await fieldValue(shop, entityId, 'phone')).toBeNull();

    // A single ready field fits the remaining capacity exactly.
    const single = await executeAgentTool({
      db: env.DB,
      workspaceId: shop.ws,
      actorUserId: shop.owner,
      actionId: 'act-quota-one-1',
      sourceMessageId: srcInboundId,
      toolName: 'set_fields',
      toolArgs: { entity_id: entityId, fields: [{ field_name: 'phone', value: '+40444444444' }] },
      expectedBusinessRevision: rev,
      maxDailyActions: 2,
    });
    expect(single.status).toBe('applied');
    expect(await fieldValue(shop, entityId, 'phone')).toContain('40444444444');

    // A lone question charges nothing and still parks at the limit.
    const parked = await executeAgentTool({
      db: env.DB,
      workspaceId: shop.ws,
      actorUserId: shop.owner,
      actionId: 'act-quota-q-1',
      toolName: 'set_fields',
      toolArgs: { entity_id: entityId, fields: [{ field_name: 'status', value: 'warm', provenance: 'inferred' }] },
      expectedBusinessRevision: rev + 1,
      maxDailyActions: 2,
    });
    expect(parked.status).toBe('needs_clarification');
    expect(await revision(shop.ws)).toBe(rev + 1);
  });
});

describe('legacy per-field receipts', () => {
  async function childHash(entityId: string, fieldName: string, value: unknown, provenance: string): Promise<string> {
    return sha256(JSON.stringify({
      commandName: 'set_field',
      args: { entity_id: entityId, field_name: fieldName, value, provenance },
    }));
  }

  async function insertChildReceipt(
    shop: Shop, actionId: string, entityId: string, fieldName: string, value: unknown, rev: number,
  ): Promise<void> {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO action_receipts (
         id, workspace_id, action_id, payload_hash, command_name, result_status, result_json,
         actor_kind, actor_user_id, source_message_id, source_job_id, run_id, step_id,
         committed_revision, created_at
       ) VALUES (?, ?, ?, ?, 'set_field', 'applied', ?, 'member', ?, NULL, NULL, NULL, NULL, ?, ?)`,
    ).bind(
      `rcpt_${actionId}`, shop.ws, actionId,
      await childHash(entityId, fieldName, value, 'stated'),
      JSON.stringify({ status: 'applied', action_id: actionId }),
      shop.owner, rev, now,
    ).run();
  }

  it('completes without reapplying fully committed children', async () => {
    const entityId = await seedEntity(shopD, 'l1', 'Legacy Client');
    const rev = await revision(shopD.ws);
    const eventsBefore = await eventCount(shopD);
    await insertChildReceipt(shopD, 'act-leg-full_f0', entityId, 'phone', '+40555555555', rev + 1);
    await insertChildReceipt(shopD, 'act-leg-full_f1', entityId, 'preferred_language', 'ro', rev + 2);

    // Same parent action id as the old loop would have used: every child
    // matches, so nothing commits and nothing replays.
    const res = await executeAgentTool({
      db: env.DB,
      workspaceId: shopD.ws,
      actorUserId: shopD.owner,
      actionId: 'act-leg-full',
      toolName: 'set_fields',
      toolArgs: {
        entity_id: entityId,
        fields: [
          { field_name: 'phone', value: '+40555555555' },
          { field_name: 'preferred_language', value: 'ro' },
        ],
      },
      expectedBusinessRevision: rev,
    });
    expect(res.status).toBe('applied');
    expect(res.summary).toContain('previously committed');
    expect(await eventCount(shopD)).toBe(eventsBefore);
  });

  it('finishes only the remainder sequentially after a partial legacy loop', async () => {
    const entityId = await seedEntity(shopD, 'l2', 'Partial Client');
    const rev = await revision(shopD.ws);
    const eventsBefore = await eventCount(shopD);
    await insertChildReceipt(shopD, 'act-leg-part_f0', entityId, 'phone', '+40666666666', rev + 1);
    // The verified child really advanced the workspace: replay at the
    // original revision must reconstruct, not conflict.
    await env.DB.prepare(`UPDATE workspaces SET business_revision = ? WHERE id = ?`)
      .bind(rev + 1, shopD.ws).run();
    const src = await acceptWebMessage(env.DB, {
      workspaceId: shopD.ws,
      chatId: shopD.chatId,
      userId: shopD.owner,
      clientMessageId: 'cm-leg-src-1',
      text: 'Update Partial Client details',
    });
    void src;
    const srcInboundId = await inboundIdForClientMessage(shopD, 'cm-leg-src-1');

    // Drive the legacy path directly: same parent action id as the old loop.
    const res = await executeAgentTool({
      db: env.DB,
      workspaceId: shopD.ws,
      actorUserId: shopD.owner,
      actionId: 'act-leg-part',
      sourceMessageId: srcInboundId,
      toolName: 'set_fields',
      toolArgs: {
        entity_id: entityId,
        fields: [
          { field_name: 'phone', value: '+40666666666' },
          { field_name: 'preferred_language', value: 'hu' },
        ],
      },
      expectedBusinessRevision: rev,
    });
    expect(res.status).toBe('applied');
    expect(res.summary).toContain('legacy sequential');
    expect(await eventCount(shopD)).toBe(eventsBefore + 1);
    expect(await revision(shopD.ws)).toBe(rev + 2);
    const lang = await env.DB.prepare(
      `SELECT value_text FROM entity_state WHERE workspace_id = ? AND entity_id = ? AND field_name = 'preferred_language'`,
    ).bind(shopD.ws, entityId).first<{ value_text: string | null }>();
    expect(lang?.value_text).toContain('hu');
  });

  it('conflicts when the live revision outruns the verified children', async () => {
    const entityId = await seedEntity(shopD, 'l3', 'Teammate Client');
    const rev = await revision(shopD.ws);
    await insertChildReceipt(shopD, 'act-leg-tm_f0', entityId, 'phone', '+40777777777', rev + 1);
    // Verified child advanced to rev+1, then a teammate committed rev+2:
    // the replay must not silently rebase around it.
    await env.DB.prepare(`UPDATE workspaces SET business_revision = ? WHERE id = ?`)
      .bind(rev + 2, shopD.ws).run();
    const eventsBefore = await eventCount(shopD);
    const res = await executeAgentTool({
      db: env.DB,
      workspaceId: shopD.ws,
      actorUserId: shopD.owner,
      actionId: 'act-leg-tm',
      toolName: 'set_fields',
      toolArgs: {
        entity_id: entityId,
        fields: [
          { field_name: 'phone', value: '+40777777777' },
          { field_name: 'preferred_language', value: 'ro' },
        ],
      },
      expectedBusinessRevision: rev,
    });
    expect(res.status).toBe('conflict');
    expect(res.error?.code).toBe('revision_conflict');
    expect(await eventCount(shopD)).toBe(eventsBefore);
  });
});

describe('targeted hydration scales with touched rows, not workspace size', () => {
  function countingDb(db: D1Database) {
    let prepares = 0;
    let batches = 0;
    const target = db as unknown as Record<string, unknown>;
    const proxy = new Proxy(target, {
      get(t, prop, receiver) {
        if (prop === 'prepare') {
          return (query: string) => {
            prepares += 1;
            return (t['prepare'] as (q: string) => D1PreparedStatement).call(t, query);
          };
        }
        if (prop === 'batch') {
          return (statements: D1PreparedStatement[]) => {
            batches += 1;
            return (t['batch'] as (s: D1PreparedStatement[]) => Promise<D1Result[]>) .call(t, statements);
          };
        }
        const value = Reflect.get(t, prop, receiver);
        return typeof value === 'function' ? (value as (...a: never[]) => unknown).bind(t) : value;
      },
    });
    return { db: proxy as unknown as D1Database, counts: () => ({ prepares, batches }) };
  }

  async function seedRawEntities(shop: Shop, count: number): Promise<string[]> {
    const now = new Date().toISOString();
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `ent_bulk_${shop.ws}_${i}`;
      ids.push(id);
      await env.DB.prepare(
        `INSERT INTO entities (id, workspace_id, name, kind, status, assigned_user_id, created_at, updated_at)
         VALUES (?, ?, ?, 'lead', 'new', NULL, ?, ?)`,
      ).bind(id, shop.ws, `Bulk ${i}`, now, now).run();
    }
    return ids;
  }

  it('issues identical statement counts for 5 vs 60 entities and uses indexes', async () => {
    const small = await makeShop('s');
    const large = await makeShop('l');
    const [smallTarget] = await seedRawEntities(small, 5);
    const [largeTarget] = await seedRawEntities(large, 60);
    const revSmall = await revision(small.ws);
    const revLarge = await revision(large.ws);
    await acceptWebMessage(env.DB, {
      workspaceId: small.ws, chatId: small.chatId, userId: small.owner,
      clientMessageId: 'cm-hyd-src-small', text: 'Update bulk lead phone',
    });
    await acceptWebMessage(env.DB, {
      workspaceId: large.ws, chatId: large.chatId, userId: large.owner,
      clientMessageId: 'cm-hyd-src-large', text: 'Update bulk lead phone',
    });
    const smallSrc = await inboundIdForClientMessage(small, 'cm-hyd-src-small');
    const largeSrc = await inboundIdForClientMessage(large, 'cm-hyd-src-large');

    const smallCounted = countingDb(env.DB);
    const smallRes = await executeAgentTool({
      db: smallCounted.db,
      workspaceId: small.ws,
      actorUserId: small.owner,
      actionId: 'act-hyd-small-1',
      sourceMessageId: smallSrc,
      toolName: 'set_fields',
      toolArgs: { entity_id: smallTarget, fields: [{ field_name: 'phone', value: '+40000000001' }] },
      expectedBusinessRevision: revSmall,
    });
    expect(smallRes.status).toBe('applied');

    const largeCounted = countingDb(env.DB);
    const largeRes = await executeAgentTool({
      db: largeCounted.db,
      workspaceId: large.ws,
      actorUserId: large.owner,
      actionId: 'act-hyd-large-1',
      sourceMessageId: largeSrc,
      toolName: 'set_fields',
      toolArgs: { entity_id: largeTarget, fields: [{ field_name: 'phone', value: '+40000000002' }] },
      expectedBusinessRevision: revLarge,
    });
    expect(largeRes.status).toBe('applied');

    // Same touched rows, same statements: hydration does not grow with the
    // workspace. Field writes load entity + requested fields only.
    expect(largeCounted.counts()).toEqual(smallCounted.counts());
    // Structural proof: one read batch (fields, contact and redirect hints)
    // plus one commit batch, independent of workspace size.
    expect(smallCounted.counts()).toEqual({ prepares: 16, batches: 2 });

    const explainCases: { sql: string; binds: string[] }[] = [
      {
        sql: `SELECT id, workspace_id, name, kind, status, assigned_user_id, created_at, updated_at
              FROM entities WHERE workspace_id = ? AND id = ?`,
        binds: ['ws-probe', 'ent-probe'],
      },
      {
        sql: `SELECT id, workspace_id, entity_id, field_name, state, value_text, value_json,
                     provenance, source_event_id, candidate_event_ids_json, last_confirmed_value_text,
                     last_confirmed_value_json, revision, updated_at
              FROM entity_state WHERE workspace_id = ? AND entity_id = ? AND field_name IN (?)`,
        binds: ['ws-probe', 'ent-probe', 'phone'],
      },
    ];
    for (const { sql, binds } of explainCases) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...binds)
        .all<{ detail: string }>();
      expect(plan.results.length).toBeGreaterThan(0);
      for (const row of plan.results) expect(row.detail).toContain('SEARCH');
    }
  });
});

async function legacySetup(suffix: string, fields: { field_name: string; value: unknown; provenance: string }[]) {
  const shop = await makeShop(suffix);
  const entityId = await seedEntity(shop, `${suffix}-ent`, `Fallback Client ${suffix}`);
  const src = await acceptWebMessage(env.DB, {
    workspaceId: shop.ws,
    chatId: shop.chatId,
    userId: shop.owner,
    clientMessageId: `cm-fb-src-${suffix}`,
    text: `Fallback Client ${suffix} seems warm`,
  });
  void src;
  const srcInboundId = await inboundIdForClientMessage(shop, `cm-fb-src-${suffix}`);
  const now = new Date().toISOString();
  const runId = `run_leg_fb_${suffix}`;
  await env.DB.prepare(
    `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, executor_kind, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'agent', 'waiting_for_input', ?, ?)`,
  ).bind(runId, shop.ws, shop.chatId, srcInboundId, now, now).run();
  const clarId = `clar_leg_fb_${suffix}`;
  const rev = await revision(shop.ws);
  await env.DB.prepare(
    `INSERT INTO pending_clarifications (
       id, workspace_id, chat_id, run_id, source_message_id, requester_user_id,
       question, intended_operation, missing_fields, candidates_json, operation_payload_json,
       answer_message_id, source_revision, status, resolution_response, resolved_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'set_fields', ?, ?, ?, NULL, ?, 'pending', NULL, NULL, ?, ?)`,
  ).bind(
    clarId, shop.ws, shop.chatId, runId, srcInboundId, shop.owner,
    `Did you want to set the status of this lead to warm?`,
    JSON.stringify(['status_confirmation']),
    JSON.stringify(['confirm', 'cancel']),
    JSON.stringify({ command: 'set_fields', params: { entity_id: entityId, fields } }),
    rev, now, now,
  ).run();
  return { shop, entityId, runId, clarId };
}

describe('legacy fallback intent recovery at the resume boundary', () => {
  it('applies an explicitly confirmed fallback without rerunning the tool', async () => {
    const { shop, entityId, clarId } = await legacySetup('f1', [
      { field_name: 'phone', value: '+40888888888', provenance: 'stated' },
      { field_name: 'status', value: 'warm', provenance: 'inferred' },
    ]);
    const reply = await answerQuestion(shop, clarId, 'confirm', 'cm-fb-ans-f1');
    expect(reply.status).toBe(202);
    expect(await fieldValue(shop, entityId, 'phone')).toContain('40888888888');
    expect(await entityStatus(shop, entityId)).toBe('warm');
    const row = await env.DB.prepare(`SELECT status FROM pending_clarifications WHERE id = ?`)
      .bind(clarId).first<{ status: string }>();
    expect(row?.status).toBe('resolved');
    // No second question was parked for the same run.
    const pending = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM pending_clarifications WHERE workspace_id = ? AND status = 'pending'`,
    ).bind(shop.ws).first<{ n: number }>();
    expect(Number(pending?.n)).toBe(0);
  });

  it('cancels on decline and leaves ambiguity pending', async () => {
    const declined = await legacySetup('f2', [
      { field_name: 'status', value: 'warm', provenance: 'inferred' },
    ]);
    const no = await answerQuestion(declined.shop, declined.clarId, 'cancel', 'cm-fb-ans-f2');
    expect(no.status).toBe(202);
    expect(await entityStatus(declined.shop, declined.entityId)).toBe('new');

    const vague = await legacySetup('f3', [
      { field_name: 'status', value: 'warm', provenance: 'inferred' },
    ]);
    const maybe = await answerQuestion(vague.shop, vague.clarId, 'maybe later', 'cm-fb-ans-f3');
    expect(maybe.status).toBe(422);
    const row = await env.DB.prepare(`SELECT status FROM pending_clarifications WHERE id = ?`)
      .bind(vague.clarId).first<{ status: string }>();
    expect(row?.status).toBe('pending');
  });
});

describe('audit repair round: approval atomicity, replay honesty, guarded decline', () => {
  async function rowOp(shop: Shop, clarId: string) {
    const row = await env.DB.prepare(
      `SELECT status, missing_fields, operation_payload_json FROM pending_clarifications WHERE id = ?`,
    ).bind(clarId).first<{ status: string; missing_fields: string; operation_payload_json: string }>();
    return {
      status: row?.status,
      missing: JSON.parse(row?.missing_fields ?? '[]') as string[],
      op: JSON.parse(row?.operation_payload_json ?? '{}') as Record<string, unknown>,
    };
  }

  it('P1-1: a rolled-back approval leaves no armed metadata behind', async () => {
    const shop = await makeShop('g1');
    const entityId = await seedEntity(shop, 'g1-ent', 'Atomic Client');
    const src = await acceptWebMessage(env.DB, {
      workspaceId: shop.ws, chatId: shop.chatId, userId: shop.owner,
      clientMessageId: 'cm-g1-src-1', text: 'Atomic Client seems warm',
    });
    void src;
    const srcInboundId = await inboundIdForClientMessage(shop, 'cm-g1-src-1');
    const now = new Date().toISOString();
    const runId = 'run_audit_g1';
    await env.DB.prepare(
      `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, executor_kind, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'agent', 'waiting_for_input', ?, ?)`,
    ).bind(runId, shop.ws, shop.chatId, srcInboundId, now, now).run();
    const clarId = 'clar_audit_g1';
    const rev = await revision(shop.ws);
    const fallbackOp = {
      command: 'set_fields',
      params: {
        entity_id: entityId,
        fields: [{ field_name: 'status', value: 'warm', provenance: 'inferred' }],
      },
    };
    await env.DB.prepare(
      `INSERT INTO pending_clarifications (
         id, workspace_id, chat_id, run_id, source_message_id, requester_user_id,
         question, intended_operation, missing_fields, candidates_json, operation_payload_json,
         answer_message_id, source_revision, status, resolution_response, resolved_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'set_fields', ?, ?, ?, NULL, ?, 'pending', NULL, NULL, ?, ?)`,
    ).bind(
      clarId, shop.ws, shop.chatId, runId, srcInboundId, shop.owner,
      'Did you want to set the status of this lead to warm?',
      JSON.stringify(['status_confirmation']), JSON.stringify(['confirm', 'cancel']),
      JSON.stringify(fallbackOp), rev, now, now,
    ).run();
    await acceptWebMessage(env.DB, {
      workspaceId: shop.ws, chatId: shop.chatId, userId: shop.owner,
      clientMessageId: 'cm-g1-ans-1', text: 'confirm',
    });
    const ansInboundId = await inboundIdForClientMessage(shop, 'cm-g1-ans-1');

    // Normalized approval plus an injected SQL failure: the whole batch,
    // including the row sync, must roll back together (non-guard batch
    // failures propagate; nothing persists).
    const badStmt = env.DB.prepare(`INSERT INTO no_such_table (id) VALUES (?)`).bind('x');
    await expect(
      resumePendingClarification(
        env.DB,
        {
          workspace_id: shop.ws,
          action_id: `act_compat_${clarId}:resumed`,
          actor: { kind: 'member', user_id: shop.owner },
          membership_revision: 1,
          request_id: 'req_audit_g1',
          expected_business_revision: rev,
          source_message_id: ansInboundId,
          run_id: runId,
          chat_id: shop.chatId,
          resuming_clarification_id: clarId,
        },
        {
          clarification_id: clarId,
          resolved_fields: {},
          resolution_response: 'confirm',
          normalizedOperation: {
            version: 1,
            command_name: 'set_fields',
            action_id: `act_compat_${clarId}`,
            args: {
              entity_id: entityId,
              fields: [{ field_name: 'status', value: 'warm', provenance: 'inferred' }],
              explicit_status_indexes: [0],
            },
            missing_fields: [],
            source_revision: rev,
          },
          normalizedMissingFields: [],
        },
        undefined,
        [badStmt],
      ),
    ).rejects.toThrow(/no such table/);
    const after = await rowOp(shop, clarId);
    expect(after.status).toBe('pending');
    expect(after.op).not.toHaveProperty('command_name');
    expect(after.missing).toEqual(['status_confirmation']);
    expect(await entityStatus(shop, entityId)).toBe('new');
  });

  it('P1-1b/P2-4: failed confirm then cancel saves facts without applying status', async () => {
    const setup = await legacySetup('g2', [
      { field_name: 'phone', value: '+40999999999', provenance: 'stated' },
      { field_name: 'status', value: 'warm', provenance: 'inferred' },
    ]);
    const { shop, entityId, clarId, runId } = setup;
    await acceptWebMessage(env.DB, {
      workspaceId: shop.ws, chatId: shop.chatId, userId: shop.owner,
      clientMessageId: 'cm-g2-ans-1', text: 'confirm',
    });
    const ansInboundId = await inboundIdForClientMessage(shop, 'cm-g2-ans-1');

    // Transient failure between approval and commit: the entity vanishes.
    let armed = true;
    const failed = await resumeRun(env.DB, {
      workspaceId: shop.ws,
      runId,
      answer: { clarificationId: clarId, messageId: ansInboundId, authorUserId: shop.owner, text: 'confirm' },
      testHooks: {
        afterPrecheck: async () => {
          if (armed) {
            armed = false;
            await env.DB.prepare(`DELETE FROM entities WHERE id = ?`).bind(entityId).run();
          }
        },
      },
    });
    expect(failed.resumed).toBe(false);
    // The row was never rewritten: a later answer still faces the fallback.
    const afterFail = await rowOp(shop, clarId);
    expect(afterFail.status).toBe('pending');
    expect(afterFail.op).not.toHaveProperty('command_name');

    // Restore the entity; declining now saves the phone but never the status.
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO entities (id, workspace_id, name, kind, status, assigned_user_id, created_at, updated_at)
       VALUES (?, ?, ?, 'lead', 'new', NULL, ?, ?)`,
    ).bind(entityId, shop.ws, `Fallback Client g2`, now, now).run();
    const cancelled = await resumeRun(env.DB, {
      workspaceId: shop.ws,
      runId,
      answer: { clarificationId: clarId, messageId: ansInboundId, authorUserId: shop.owner, text: 'cancel' },
    });
    expect(cancelled.resumed).toBe(true);
    expect(await entityStatus(shop, entityId)).toBe('new');
    expect(await fieldValue(shop, entityId, 'phone')).toContain('40999999999');
    expect((await rowOp(shop, clarId)).status).toBe('cancelled');
  });

  it('P1-3: a guarded decline rejects removed membership', async () => {
    const setup = await legacySetup('g3', [
      { field_name: 'status', value: 'warm', provenance: 'inferred' },
    ]);
    const { shop, entityId, clarId, runId } = setup;
    await acceptWebMessage(env.DB, {
      workspaceId: shop.ws, chatId: shop.chatId, userId: shop.owner,
      clientMessageId: 'cm-g3-ans-1', text: 'cancel',
    });
    const ansInboundId = await inboundIdForClientMessage(shop, 'cm-g3-ans-1');
    let fired = false;
    const res = await resumeRun(env.DB, {
      workspaceId: shop.ws,
      runId,
      answer: { clarificationId: clarId, messageId: ansInboundId, authorUserId: shop.owner, text: 'cancel' },
      testHooks: {
        afterPrecheck: async () => {
          if (!fired) {
            fired = true;
            await env.DB.prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
              .bind(shop.ws, shop.owner).run();
          }
        },
      },
    });
    expect(res.resumed).toBe(false);
    expect(res.failureReason).toBe('answer_invalid');
    expect((await rowOp(shop, clarId)).status).toBe('pending');
    expect(await entityStatus(shop, entityId)).toBe('new');
  });

  it('P1-2: replays follow the persisted question, never its ghost', async () => {
    const shop = await makeShop('g4');
    const entityId = await seedEntity(shop, 'g4-ent', 'Replay Client');
    const turn = await runTurn(shop, 'cm-g4-mix-1', 'Replay Client called, seems warm', [
      {
        kind: 'tool_calls',
        calls: [{
          callId: 'c_sfrep',
          name: 'set_fields',
          args: {
            entity_id: entityId,
            fields: [
              { field_name: 'phone', value: '+40111111111' },
              { field_name: 'status', value: 'warm', provenance: 'inferred' },
            ],
          },
        }],
      },
    ]);
    expect(turn.status).toBe('waiting_for_input');
    const receipt = await env.DB.prepare(
      `SELECT action_id FROM action_receipts WHERE workspace_id = ? AND command_name = 'set_fields'
       ORDER BY created_at DESC LIMIT 1`,
    ).bind(shop.ws).first<{ action_id: string }>();
    const parentActionId = receipt!.action_id;
    const srcInboundId = await inboundIdForClientMessage(shop, 'cm-g4-mix-1');
    const replayArgs = {
      entity_id: entityId,
      fields: [
        { field_name: 'phone', value: '+40111111111', provenance: 'stated' },
        { field_name: 'status', value: 'warm', provenance: 'inferred' },
      ],
    };
    const replay = () =>
      executeAgentTool({
        db: env.DB, workspaceId: shop.ws, actorUserId: shop.owner, actionId: parentActionId,
        sourceMessageId: srcInboundId, toolName: 'set_fields', toolArgs: replayArgs,
        expectedBusinessRevision: 0,
      });

    // Retry while pending re-parks instead of skipping the question, and
    // creates no duplicate row.
    const retry = await replay();
    expect(retry.status).toBe('needs_clarification');
    const pendingCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM pending_clarifications WHERE workspace_id = ? AND status = 'pending'`,
    ).bind(shop.ws).first<{ n: number }>();
    expect(Number(pendingCount?.n)).toBe(1);

    // Answer the question, then replay: applied, asked nothing again.
    const clar = await pendingQuestion(shop, turn.runId);
    const reply = await answerQuestion(shop, clar!.id, 'confirm', 'cm-g4-ans-1');
    expect(reply.status).toBe(202);
    const afterAnswer = await replay();
    expect(afterAnswer.status).toBe('already_applied');

    // Question-only replay after a decline is terminal, never a re-ask.
    const shopQ = await makeShop('g5');
    const entityQ = await seedEntity(shopQ, 'g5-ent', 'Replay Solo');
    const soloTurn = await runTurn(shopQ, 'cm-g5-solo-1', 'Replay Solo seems warm', [
      {
        kind: 'tool_calls',
        calls: [{
          callId: 'c_sfsolo',
          name: 'set_fields',
          args: { entity_id: entityQ, fields: [{ field_name: 'status', value: 'warm', provenance: 'inferred' }] },
        }],
      },
    ]);
    expect(soloTurn.status).toBe('waiting_for_input');
    const soloReceipt = await env.DB.prepare(
      `SELECT action_id FROM action_receipts WHERE workspace_id = ? AND command_name = 'set_fields'
       ORDER BY created_at DESC LIMIT 1`,
    ).bind(shopQ.ws).first<{ action_id: string }>();
    const soloClar = await pendingQuestion(shopQ, soloTurn.runId);
    const noQ = await answerQuestion(shopQ, soloClar!.id, 'cancel', 'cm-g5-ans-1');
    expect(noQ.status).toBe(202);
    const soloSrcInboundId = await inboundIdForClientMessage(shopQ, 'cm-g5-solo-1');
    const ghost = await executeAgentTool({
      db: env.DB, workspaceId: shopQ.ws, actorUserId: shopQ.owner, actionId: soloReceipt!.action_id,
      sourceMessageId: soloSrcInboundId, toolName: 'set_fields',
      toolArgs: {
        entity_id: entityQ,
        fields: [{ field_name: 'status', value: 'warm', provenance: 'inferred' }],
      },
      expectedBusinessRevision: 0,
    });
    expect(ghost.status).toBe('rejected');
    expect(ghost.error?.code).toBe('already_resolved');
  });
});

describe('undo cancels the parked intent of its own batch', () => {
  it('a confirmed answer cannot resurrect undone facts', async () => {
    const entityId = await seedEntity(shopB, 'u1', 'Undo Client');
    const turn = await runTurn(shopB, 'cm-u-1', 'Undo Client called, seems warm', [
      {
        kind: 'tool_calls',
        calls: [{
          callId: 'c_sfu',
          name: 'set_fields',
          args: {
            entity_id: entityId,
            fields: [
              { field_name: 'phone', value: '+40777777777' },
              { field_name: 'status', value: 'warm', provenance: 'inferred' },
            ],
          },
        }],
      },
    ]);
    const clar = await pendingQuestion(shopB, turn.runId);
    const receipt = await env.DB.prepare(
      `SELECT action_id FROM action_receipts WHERE workspace_id = ? AND command_name = 'set_fields'
       ORDER BY created_at DESC LIMIT 1`,
    ).bind(shopB.ws).first<{ action_id: string }>();

    const previewRes = await call(`/api/workspaces/${shopB.ws}/actions/${receipt!.action_id}/undo-preview`, {
      method: 'POST',
      cookie: shopB.cookie,
      headers: CSRF,
      body: JSON.stringify({ mode: 'single' }),
    });
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as { preview: { expected_revision: number } };
    const undoRes = await call(`/api/workspaces/${shopB.ws}/actions/${receipt!.action_id}/undo?chat_id=${shopB.chatId}`, {
      method: 'POST',
      cookie: shopB.cookie,
      headers: CSRF,
      body: JSON.stringify({
        mode: 'single',
        client_operation_id: 'undo-op-batch-1',
        expected_revision: preview.preview.expected_revision,
      }),
    });
    expect(undoRes.status).toBe(200);

    const late = await answerQuestion(shopB, clar!.id, 'confirm', 'cm-u-late-1');
    expect(late.status).not.toBe(202);
    expect(await entityStatus(shopB, entityId)).toBe('new');
    expect(await fieldValue(shopB, entityId, 'phone')).toBeNull();
  });
});

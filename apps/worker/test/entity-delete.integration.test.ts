import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
import { AUTH_BOUNDS } from '@otis/contracts';
import { acceptWebMessage, createChat } from '../src/inbox/repository.js';
import { dispatchOutboxItem } from '../src/actor/dispatch.js';
import { AgentHandler } from '../src/agent/handler.js';
import { FakeProviderAdapter } from '@otis/agent';
import { sha256 } from '@otis/identity';

/**
 * Conversational entity deletion and the correction guard, on workerd D1:
 * the delete tool asks for member confirmation, the confirmed answer
 * resumes the exact operation, the lead and all of its details leave every
 * projection while history stays, and a text-only answer to an explicit
 * value correction steers one more round instead of completing unfixed.
 */

const CSRF = {
  origin: 'http://localhost',
  [AUTH_BOUNDS.CSRF_HEADER]: '1',
  'Content-Type': 'application/json',
};

const WS = 'ws-entity-delete';
const OWNER = 'usr_del_owner';

let ownerCookie = '';
let chatId = '';

async function call(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('Cookie', init.cookie);
  return SELF.fetch(`http://localhost${path}`, { ...init, headers });
}

async function outboxIdForRun(runId: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT id FROM outbox WHERE json_extract(payload_json, '$.run_id') = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(runId)
    .first<{ id: string }>();
  if (!row) throw new Error(`outbox for run ${runId} missing`);
  return row.id;
}

const testLimits = { maxDailyActions: 50, maxRoundsPerRun: 10 };

beforeAll(async () => {
  await applyMigrations(env.DB);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
     VALUES (?, 'fb_del_owner', 'owner@del.test', 'Owner', ?, ?)`,
  ).bind(OWNER, now, now).run();
  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
     VALUES (?, 'Delete Shop', ?, 0, 1, ?, ?)`,
  ).bind(WS, OWNER, now, now).run();
  await env.DB.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?, ?)`,
  ).bind(WS, OWNER, now, now, now).run();
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
     VALUES ('sess_del_owner', ?, ?, ?, ?, NULL, ?)`,
  ).bind(await sha256('del_token_owner'), OWNER, now, expiresAt, now).run();
  ownerCookie = `${AUTH_BOUNDS.COOKIE_NAME}=del_token_owner`;
  chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: OWNER, title: 'Delete flow' })).id;
});

describe('conversational entity deletion', () => {
  it('asks for confirmation, then deletes the lead and all of its details on yes', async () => {
    const seeded = await acceptWebMessage(env.DB, {
      workspaceId: WS,
      chatId,
      userId: OWNER,
      clientMessageId: 'cm-del-seed-1',
      text: 'Record lead Fake Client',
    });
    const seedFake = new FakeProviderAdapter({
      scripts: [
        { kind: 'tool_calls', calls: [{ callId: 'c_upsert', name: 'upsert_entity', args: { name: 'Fake Client' } }] },
        { kind: 'text', text: 'Recorded Fake Client.' },
      ],
    });
    const seedHandler = new AgentHandler({ providerAdapter: seedFake, limits: testLimits, maxRoundsPerSlice: 3 });
    const seedRes = await dispatchOutboxItem(env.DB, await outboxIdForRun(seeded.run_id), WS, { handler: seedHandler });
    expect(seedRes.status).toBe('completed');
    const entity = await env.DB.prepare(`SELECT id FROM entities WHERE workspace_id = ? AND name = ?`)
      .bind(WS, 'Fake Client')
      .first<{ id: string }>();
    expect(entity).toBeTruthy();

    const asked = await acceptWebMessage(env.DB, {
      workspaceId: WS,
      chatId,
      userId: OWNER,
      clientMessageId: 'cm-del-ask-1',
      text: 'Delete Fake Client, it was fake test data',
    });
    const askFake = new FakeProviderAdapter({
      scripts: [
        {
          kind: 'tool_calls',
          calls: [{ callId: 'c_del', name: 'delete_entity', args: { entity_id: entity!.id, reason: 'fake test data' } }],
        },
      ],
    });
    const askHandler = new AgentHandler({ providerAdapter: askFake, limits: testLimits, maxRoundsPerSlice: 3 });
    const askRes = await dispatchOutboxItem(env.DB, await outboxIdForRun(asked.run_id), WS, { handler: askHandler });
    expect(askRes.status).toBe('waiting_for_input');

    // Nothing is deleted by the question itself.
    const stillThere = await env.DB.prepare(`SELECT id FROM entities WHERE id = ?`).bind(entity!.id).first();
    expect(stillThere).toBeTruthy();
    const clar = await env.DB.prepare(
      `SELECT id, question, intended_operation, operation_payload_json FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`,
    ).bind(asked.run_id).first<{
      id: string; question: string; intended_operation: string; operation_payload_json: string;
    }>();
    expect(clar?.question).toContain('Fake Client');
    expect(JSON.parse(clar!.operation_payload_json)).toMatchObject({ command_name: 'delete_entity' });

    // "yes" resumes the exact pending operation through the production route.
    const reply = await call(`/api/workspaces/${WS}/clarifications/${clar!.id}/reply`, {
      method: 'POST',
      cookie: ownerCookie,
      headers: CSRF,
      body: JSON.stringify({ text: 'yes', client_message_id: 'cm-del-confirm-1' }),
    });
    expect(reply.status).toBe(202);

    // The lead and all of its details are gone from every projection.
    for (const table of ['entities', 'entity_aliases', 'entity_state', 'tasks', 'draft_projections']) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`)
        .bind(WS)
        .first<{ n: number }>();
      expect(`${table}:${Number(row?.n ?? -1)}`).toBe(`${table}:0`);
    }
    // History stays: the delete event is recorded, not a row removal.
    const delEvent = await env.DB.prepare(
      `SELECT kind, payload_json FROM events WHERE workspace_id = ? AND kind = 'entity_deleted'`,
    ).bind(WS).first<{ kind: string; payload_json: string }>();
    expect(delEvent?.kind).toBe('entity_deleted');
    expect(JSON.parse(delEvent!.payload_json)).toMatchObject({ name: 'Fake Client' });
    // Future reads never see the faulty lead again.
    const overview = await env.DB.prepare(`SELECT COUNT(*) AS n FROM entities WHERE workspace_id = ?`)
      .bind(WS)
      .first<{ n: number }>();
    expect(Number(overview?.n)).toBe(0);
  });

  it('cancels cleanly on no, leaving the lead untouched', async () => {
    const seeded = await acceptWebMessage(env.DB, {
      workspaceId: WS,
      chatId,
      userId: OWNER,
      clientMessageId: 'cm-del-seed-2',
      text: 'Record lead Keeper Client',
    });
    const seedFake = new FakeProviderAdapter({
      scripts: [
        { kind: 'tool_calls', calls: [{ callId: 'c_up2', name: 'upsert_entity', args: { name: 'Keeper Client' } }] },
        { kind: 'text', text: 'Recorded.' },
      ],
    });
    const seedRes = await dispatchOutboxItem(
      env.DB,
      await outboxIdForRun(seeded.run_id),
      WS,
      { handler: new AgentHandler({ providerAdapter: seedFake, limits: testLimits, maxRoundsPerSlice: 3 }) },
    );
    expect(seedRes.status).toBe('completed');
    const entity = await env.DB.prepare(`SELECT id FROM entities WHERE workspace_id = ? AND name = ?`)
      .bind(WS, 'Keeper Client')
      .first<{ id: string }>();

    const asked = await acceptWebMessage(env.DB, {
      workspaceId: WS,
      chatId,
      userId: OWNER,
      clientMessageId: 'cm-del-ask-2',
      text: 'Delete Keeper Client',
    });
    const askFake = new FakeProviderAdapter({
      scripts: [
        { kind: 'tool_calls', calls: [{ callId: 'c_del2', name: 'delete_entity', args: { entity_id: entity!.id } }] },
      ],
    });
    const askRes = await dispatchOutboxItem(
      env.DB,
      await outboxIdForRun(asked.run_id),
      WS,
      { handler: new AgentHandler({ providerAdapter: askFake, limits: testLimits, maxRoundsPerSlice: 3 }) },
    );
    expect(askRes.status).toBe('waiting_for_input');
    const clar = await env.DB.prepare(
      `SELECT id FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`,
    ).bind(asked.run_id).first<{ id: string }>();

    const reply = await call(`/api/workspaces/${WS}/clarifications/${clar!.id}/reply`, {
      method: 'POST',
      cookie: ownerCookie,
      headers: CSRF,
      body: JSON.stringify({ text: 'no, keep it', client_message_id: 'cm-del-decline-1' }),
    });
    expect(reply.status).toBe(202);
    // The decline answers the question cleanly: parked as cancelled, lead kept.
    const clarStatus = await env.DB.prepare(`SELECT status FROM pending_clarifications WHERE id = ?`)
      .bind(clar!.id)
      .first<{ status: string }>();
    expect(clarStatus?.status).toBe('cancelled');
    const kept = await env.DB.prepare(`SELECT id FROM entities WHERE id = ?`).bind(entity!.id).first();
    expect(kept).toBeTruthy();
    const noDelete = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND kind = 'entity_deleted' AND entity_id = ?`,
    ).bind(WS, entity!.id).first<{ n: number }>();
    expect(Number(noDelete?.n)).toBe(0);
  });
});

describe('correction guard', () => {
  it('steers one more round when a text-only answer meets an explicit value correction', async () => {
    const seeded = await acceptWebMessage(env.DB, {
      workspaceId: WS,
      chatId,
      userId: OWNER,
      clientMessageId: 'cm-guard-seed-1',
      text: 'Record lead Guard Client',
    });
    const seedFake = new FakeProviderAdapter({
      scripts: [
        { kind: 'tool_calls', calls: [{ callId: 'c_gup', name: 'upsert_entity', args: { name: 'Guard Client' } }] },
        { kind: 'text', text: 'Recorded.' },
      ],
    });
    await dispatchOutboxItem(
      env.DB,
      await outboxIdForRun(seeded.run_id),
      WS,
      { handler: new AgentHandler({ providerAdapter: seedFake, limits: testLimits, maxRoundsPerSlice: 3 }) },
    );
    const entity = await env.DB.prepare(`SELECT id FROM entities WHERE workspace_id = ? AND name = ?`)
      .bind(WS, 'Guard Client')
      .first<{ id: string }>();

    // The reported failure shape: a fix promised in words with zero tool calls.
    const corrected = await acceptWebMessage(env.DB, {
      workspaceId: WS,
      chatId,
      userId: OWNER,
      clientMessageId: 'cm-guard-fix-1',
      text: 'WHAT, i had said 4000 RON not 400,000!',
    });
    const guardFake = new FakeProviderAdapter({
      scripts: [
        { kind: 'text', text: 'Ah, my bad — good catch. Let us fix that right away.' },
        {
          kind: 'tool_calls',
          calls: [{
            callId: 'c_gfix',
            name: 'set_fields',
            args: {
              entity_id: entity!.id,
              fields: [{ field_name: 'quote', value: { amount: 400000, currency: 'RON', role: 'expected' } }],
            },
          }],
        },
        { kind: 'text', text: 'Fixed: the expected quote is now 4,000 RON.' },
      ],
    });
    const guardRes = await dispatchOutboxItem(
      env.DB,
      await outboxIdForRun(corrected.run_id),
      WS,
      { handler: new AgentHandler({ providerAdapter: guardFake, limits: testLimits, maxRoundsPerSlice: 4 }) },
    );
    expect(guardRes.status).toBe('completed');
    // The guard fired exactly once: three provider rounds, the steered one
    // carrying the correction instruction.
    expect(guardFake.calls.length).toBe(3);
    expect(JSON.stringify(guardFake.inputs[1])).toContain('[Correction guard]');
    // The correction actually landed with correct minor units. set_fields
    // stores quotes as JSON; the log_event path renders major-unit text
    // (covered in ledger pure tests).
    const quote = await env.DB.prepare(
      `SELECT value_json FROM entity_state WHERE workspace_id = ? AND entity_id = ? AND field_name = 'quote'`,
    ).bind(WS, entity!.id).first<{ value_json: string }>();
    expect(JSON.parse(quote!.value_json)).toMatchObject({ amount: 400000, currency: 'RON', role: 'expected' });
  });

  it('leaves ordinary text-only answers alone', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: WS,
      chatId,
      userId: OWNER,
      clientMessageId: 'cm-guard-quiet-1',
      text: 'thanks!',
    });
    const quietFake = new FakeProviderAdapter({
      scripts: [{ kind: 'text', text: 'You are welcome.' }],
    });
    const res = await dispatchOutboxItem(
      env.DB,
      await outboxIdForRun(accepted.run_id),
      WS,
      { handler: new AgentHandler({ providerAdapter: quietFake, limits: testLimits, maxRoundsPerSlice: 3 }) },
    );
    expect(res.status).toBe('completed');
    expect(quietFake.calls.length).toBe(1);
  });
});

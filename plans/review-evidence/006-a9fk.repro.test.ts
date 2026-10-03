/* eslint-disable @typescript-eslint/no-explicit-any -- Review-only diagnostic probe, not an acceptance test. */
// Lean re-verification of the undo FOREIGN KEY failure: a bare/explicit undo
// of an entity creation in a chat whose workspace also holds an applied quote
// plus a parked waiting_for_input run. Desired: completed + entity removed.
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
// @ts-expect-error vite raw import
import migration0001Sql from '../../migrations/0001_identity.sql?raw';
// @ts-expect-error vite raw import
import migration0002Sql from '../../migrations/0002_conversations_sources.sql?raw';
// @ts-expect-error vite raw import
import migration0003Sql from '../../migrations/0003_ledger.sql?raw';
// @ts-expect-error vite raw import
import migration0004Sql from '../../migrations/0004_lifecycle_settings.sql?raw';
// @ts-expect-error vite raw import
import migration0005Sql from '../../migrations/0005_actor_dispatch.sql?raw';
// @ts-expect-error vite raw import
import migration0006Sql from '../../migrations/0006_actor_hardening.sql?raw';
// @ts-expect-error vite raw import
import migration0007Sql from '../../migrations/0007_outbox_claim_owner.sql?raw';
// @ts-expect-error vite raw import
import migration0008Sql from '../../migrations/0008_memory_and_agent_runs.sql?raw';
// @ts-expect-error vite raw import
import migration0009Sql from '../../migrations/0009_thinking_controls.sql?raw';

import { AgentHandler } from '../../apps/worker/src/agent/handler.js';
import { dispatchOutboxItem } from '../../apps/worker/src/actor/dispatch.js';
import { acceptWebMessage, createChat } from '../../apps/worker/src/inbox/repository.js';
import { FakeProviderAdapter } from '../../packages/agent/src/index.js';

describe('DIAG undo FK with quote+waiting pollution (review probe)', () => {
  const ws = 'ws-diag-fk';
  const aviId = 'usr_avi_diag_fk';
  let chat: string;
  const nowIso = new Date().toISOString();
  const limits = { maxDailyActions: 50, maxRoundsPerRun: 10 };

  function splitSqlStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let inTrigger = false;
    for (const rawLine of sql.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('--') || line.length === 0) continue;
      current += rawLine + '\n';
      if (/\bBEGIN\b/i.test(line)) inTrigger = true;
      if (inTrigger) {
        if (/\bEND;\s*$/i.test(line)) {
          inTrigger = false;
          statements.push(current.trim());
          current = '';
        }
      } else if (line.endsWith(';')) {
        statements.push(current.trim());
        current = '';
      }
    }
    if (current.trim().length > 0) statements.push(current.trim());
    return statements;
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

  function makeHandler(scripts: any[]) {
    return new AgentHandler({ providerAdapter: new FakeProviderAdapter({ scripts }), limits, maxRoundsPerSlice: 3 });
  }

  beforeAll(async () => {
    for (const sql of [migration0001Sql, migration0002Sql, migration0003Sql, migration0004Sql, migration0005Sql, migration0006Sql, migration0007Sql, migration0008Sql, migration0009Sql]) {
      for (const stmt of splitSqlStatements(sql)) {
        await env.DB.prepare(stmt).run();
      }
    }
    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(aviId, `fb_${aviId}`, 'avi.fk@kerning.test', 'Avi Fk', nowIso, nowIso)
      .run();
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at) VALUES (?, 'Fk WS', ?, 0, 1, ?, ?)`,
    )
      .bind(ws, aviId, nowIso, nowIso)
      .run();
    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)`,
    )
      .bind(ws, aviId, nowIso, nowIso, nowIso)
      .run();
    chat = (await createChat(env.DB, { workspaceId: ws, authorUserId: aviId, title: 'Fk Chat' })).id;
  });

  it('bare undo completes when a quote and a waiting run exist in the same chat', async () => {
    await env.DB.prepare(
      `INSERT INTO entities (id, workspace_id, name, kind, status, created_at, updated_at) VALUES (?, ?, 'Fk Co', 'business', 'new', ?, ?)`,
    ).bind('ent_fk', ws, nowIso, nowIso).run();
    const pol = await acceptWebMessage(env.DB, { workspaceId: ws, chatId: chat, userId: aviId, clientMessageId: 'fk-pol', text: 'price talk' });
    const polRes = await dispatchOutboxItem(env.DB, await outboxIdForRun(pol.run_id), ws, {
      handler: makeHandler([
        { kind: 'tool_calls', calls: [
          { callId: 'fq1', name: 'log_event', args: { entity_id: 'ent_fk', kind: 'quote', payload: { amount: 100, currency: 'RON', role: 'offered' } } },
        ] },
        { kind: 'text', text: 'Quote saved.' },
      ]),
    });
    expect(polRes.status).toBe('completed');

    const acc1 = await acceptWebMessage(env.DB, { workspaceId: ws, chatId: chat, userId: aviId, clientMessageId: 'fk-create', text: 'Record lead Fk Press' });
    const r1 = await dispatchOutboxItem(env.DB, await outboxIdForRun(acc1.run_id), ws, {
      handler: makeHandler([
        { kind: 'tool_calls', calls: [{ callId: 'c_fp', name: 'upsert_entity', args: { name: 'Fk Press' } }] },
        { kind: 'text', text: 'Created.' },
      ]),
    });
    expect(r1.status).toBe('completed');

    const acc2 = await acceptWebMessage(env.DB, { workspaceId: ws, chatId: chat, userId: aviId, clientMessageId: 'fk-undo', text: 'Undo that' });
    const outboxId = await outboxIdForRun(acc2.run_id);
    let last: any = null;
    for (let i = 0; i < 5; i++) {
      last = await dispatchOutboxItem(env.DB, outboxId, ws, {
        handler: makeHandler([
          { kind: 'tool_calls', calls: [{ callId: 'c_u', name: 'undo', args: { mode: 'single' } }] },
          { kind: 'text', text: 'Undid.' },
        ]),
      });
      if (last.status !== 'deferred') break;
    }
    console.log('FKUNDO last dispatch:', JSON.stringify(last));
    const runRow = await env.DB.prepare('SELECT status, error_code, error_message FROM agent_runs WHERE id = ?').bind(acc2.run_id).first<any>();
    console.log('FKUNDO run row:', JSON.stringify(runRow));
    expect(last.status).toBe('completed');
    const entAfter = await env.DB.prepare('SELECT id FROM entities WHERE workspace_id = ? AND name = ?').bind(ws, 'Fk Press').first();
    expect(entAfter).toBeNull();
  });
});

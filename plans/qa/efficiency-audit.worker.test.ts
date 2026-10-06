import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../../apps/worker/test/migrations.js';
import { acceptWebMessage, createChat } from '../../apps/worker/src/inbox/repository.js';
import { dispatchOutboxItem } from '../../apps/worker/src/actor/dispatch.js';
import { AgentHandler } from '../../apps/worker/src/agent/handler.js';
import { FakeProviderAdapter, type FakeTurnScript } from '../../packages/agent/src/providers/fake.js';

const workspaceId = 'ws-efficiency-audit';
const userId = 'user-efficiency-audit';
const now = new Date().toISOString();

function countDb(db: D1Database) {
  const calls: string[] = [];
  const statements: string[] = [];
  const inner = new WeakMap<object, D1PreparedStatement>();
  function wrap(sql: string, statement: D1PreparedStatement): D1PreparedStatement {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(sql, statement.bind(...values)),
      first: async (column?: string) => { calls.push('first'); statements.push(sql); return statement.first(column); },
      all: async () => { calls.push('all'); statements.push(sql); return statement.all(); },
      run: async () => { calls.push('run'); statements.push(sql); return statement.run(); },
      raw: async () => { calls.push('raw'); statements.push(sql); return statement.raw(); },
    } as unknown as D1PreparedStatement;
    inner.set(wrapped, statement);
    return wrapped;
  }
  const counted = {
    prepare: (sql: string) => wrap(sql, db.prepare(sql)),
    batch: async (batch: D1PreparedStatement[]) => {
      calls.push('batch');
      statements.push(...batch.map(() => '<batched statement>'));
      return db.batch(batch.map(statement => inner.get(statement) ?? statement));
    },
  } as unknown as D1Database;
  return { db: counted, calls, statements };
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, firebase_uid, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(userId, 'firebase-efficiency-fixture', 'Audit fixture', now, now),
    env.DB.prepare('INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(workspaceId, 'Efficiency fixture', userId, now, now),
    env.DB.prepare("INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)")
      .bind(workspaceId, userId, now, now, now),
  ]);
});

describe('Real local D1 audit profiles; no live providers', () => {
  it.each([
    ['greeting', [{ kind: 'text', text: 'Hello.' }]],
    ['one entity capture', [
      { kind: 'tool_calls', calls: [{ callId: 'audit-upsert', name: 'upsert_entity', args: { name: 'Audit new business', kind: 'business' } }] },
      { kind: 'text', text: 'Saved.' },
    ]],
  ] as Array<[string, FakeTurnScript[]]>)('profiles acceptance and dispatch for %s', async (label, scripts) => {
    const chat = await createChat(env.DB, { workspaceId, authorUserId: userId, title: label });
    const acceptance = countDb(env.DB);
    const accepted = await acceptWebMessage(acceptance.db, {
      workspaceId, chatId: chat.id, userId, clientMessageId: `audit-${crypto.randomUUID()}`, text: label,
    });
    const outbox = await env.DB.prepare("SELECT id FROM outbox WHERE json_extract(payload_json, '$.run_id') = ? LIMIT 1")
      .bind(accepted.run_id).first<{ id: string }>();
    expect(outbox).not.toBeNull();
    const provider = new FakeProviderAdapter({ provider: 'gemini', scripts });
    const handler = new AgentHandler({ providerAdapter: provider, limits: { maxDailyActions: 50, maxRoundsPerRun: 10 } });
    const dispatch = countDb(env.DB);
    const result = await dispatchOutboxItem(dispatch.db, outbox!.id, workspaceId, { handler });
    expect(result.status).toBe('completed');
    expect(provider.calls).toHaveLength(scripts.length);
    const profile = { audit: label,
      acceptanceBindingCalls: acceptance.calls.length, acceptanceStatements: acceptance.statements.length,
      dispatchBindingCalls: dispatch.calls.length, dispatchStatements: dispatch.statements.length,
      providerRounds: provider.calls.length,
    };
    expect(profile).toMatchSnapshot(label);
  });

  it('profiles acceptance and dispatch for a two-image turn', async () => {
    const chat = await createChat(env.DB, { workspaceId, authorUserId: userId, title: 'image turn' });
    // Validated image rows via SQL: acceptance reads D1 rows only, never R2.
    // The handler runs without storage here, so this profiles the acceptance
    // link cost plus a text turn, not byte transport.
    for (const [mediaId, clientId, format] of [
      ['med_audit_img1', 'audit-img-1', 'image/png'],
      ['med_audit_img2', 'audit-img-2', 'image/jpeg'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO media_objects (id, workspace_id, chat_id, uploader_user_id, client_message_id, state, object_key, content_type, format, byte_size, duration_ms, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'validated', ?, ?, ?, 2048, 0, ?, ?, ?)`,
      ).bind(mediaId, workspaceId, chat.id, userId, clientId, `workspace/${workspaceId}/media/${mediaId}`, format, format, '2027-01-01', now, now).run();
    }
    const acceptance = countDb(env.DB);
    const accepted = await acceptWebMessage(acceptance.db, {
      workspaceId, chatId: chat.id, userId, clientMessageId: `audit-${crypto.randomUUID()}`, text: 'What is this?',
      imageMediaIds: ['med_audit_img1', 'med_audit_img2'],
    });
    const outbox = await env.DB.prepare("SELECT id FROM outbox WHERE json_extract(payload_json, '$.run_id') = ? LIMIT 1")
      .bind(accepted.run_id).first<{ id: string }>();
    expect(outbox).not.toBeNull();
    const provider = new FakeProviderAdapter({ provider: 'gemini', scripts: [{ kind: 'text', text: 'Two photos.' }] });
    const handler = new AgentHandler({ providerAdapter: provider, limits: { maxDailyActions: 50, maxRoundsPerRun: 10 } });
    const dispatch = countDb(env.DB);
    const result = await dispatchOutboxItem(dispatch.db, outbox!.id, workspaceId, { handler });
    expect(result.status).toBe('completed');
    expect(provider.calls).toHaveLength(1);
    const profile = { audit: 'two image turn',
      acceptanceBindingCalls: acceptance.calls.length, acceptanceStatements: acceptance.statements.length,
      dispatchBindingCalls: dispatch.calls.length, dispatchStatements: dispatch.statements.length,
      providerRounds: provider.calls.length,
    };
    expect(profile).toMatchSnapshot('two image turn');
  });

  it('compares current chat-history and activity query plans with narrow candidate indexes', async () => {
    const queries = [
      { name: 'own chat history', sql: 'SELECT id, last_activity_at FROM chats WHERE workspace_id = ? AND author_user_id = ? ORDER BY last_activity_at DESC, id DESC LIMIT 25', bindings: [workspaceId, userId],
        index: 'CREATE INDEX audit_chat_author_recent ON chats(workspace_id, author_user_id, last_activity_at DESC, id DESC)' },
      { name: 'run activity', sql: 'SELECT id, cursor FROM run_activity WHERE workspace_id = ? AND chat_id = ? AND run_id = ? ORDER BY cursor DESC LIMIT 200', bindings: [workspaceId, 'audit-chat', 'audit-run'],
        index: 'CREATE INDEX audit_run_cursor ON run_activity(run_id, cursor DESC)' },
      { name: 'legacy cleanup', sql: 'SELECT id FROM lifecycle_guards WHERE length(id) > 40 LIMIT 500', bindings: [], index: null },
    ];
    for (const query of queries) {
      const plan = async () => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.bindings)
        .all<{ detail: string }>()).results.map(row => row.detail);
      const before = await plan();
      if (query.index) await env.DB.prepare(query.index).run();
      const after = query.index ? await plan() : before;
      expect({ auditPlan: query.name, before, after }).toMatchSnapshot(query.name);
      expect(before.length).toBeGreaterThan(0);
    }
  });
});

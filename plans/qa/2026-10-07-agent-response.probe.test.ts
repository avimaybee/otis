/** Characterization evidence: these passing assertions reproduce current gaps.
 * They are not desired-behavior regression tests or live-model quality evidence. */
import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../../apps/worker/test/migrations.js';
import { getTurnContext, sanitizeFtsQuery } from '../../apps/worker/src/agent/context.js';
import { acceptWebMessage, createChat } from '../../apps/worker/src/inbox/repository.js';
import { dispatchOutboxItem } from '../../apps/worker/src/actor/dispatch.js';
import { AgentHandler } from '../../apps/worker/src/agent/handler.js';
import { executeAgentTool } from '../../apps/worker/src/agent/repository.js';
import { FakeProviderAdapter } from '../../packages/agent/src/providers/fake.js';

const workspace = 'ws_response_probe';
const member = 'user_response_probe';
const now = new Date().toISOString();
const names = ['Cedar Works', 'Bluebird Coffee Ltd', 'Harbor Works', 'Meridian Studio'];
const entityId = (index: number) => `entity_response_${index}`;
let chat: string;

async function context(sourceText: string) {
  return getTurnContext(env.DB, { workspaceId: workspace, actorUserId: member, chatId: chat, sourceText, nowIso: now });
}

async function dispatch(script: ConstructorParameters<typeof FakeProviderAdapter>[0], text: string, clientId: string) {
  const accepted = await acceptWebMessage(env.DB, { workspaceId: workspace, chatId: chat, userId: member, clientMessageId: clientId, text });
  const outbox = await env.DB.prepare(`SELECT id FROM outbox WHERE json_extract(payload_json, '$.run_id') = ?`).bind(accepted.run_id).first<{ id: string }>();
  expect(outbox).not.toBeNull();
  const fake = new FakeProviderAdapter(script);
  const handler = new AgentHandler({ providerAdapter: fake, limits: { maxDailyActions: 50, maxRoundsPerRun: 10 } });
  const result = await dispatchOutboxItem(env.DB, outbox!.id, workspace, { handler });
  return { result, runId: accepted.run_id, fake };
}

describe('Response-quality source gaps (local Workers/D1, synthetic data)', () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
    await env.DB.prepare(`INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at) VALUES (?, ?, ?, 'Nora', ?, ?)`)
      .bind(member, 'firebase_response_probe', 'response-probe@example.test', now, now).run();
    await env.DB.prepare(`INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at) VALUES (?, 'Response probe workspace', ?, 0, 1, ?, ?)`)
      .bind(workspace, member, now, now).run();
    await env.DB.prepare(`INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)`)
      .bind(workspace, member, now, now, now).run();
    chat = (await createChat(env.DB, { workspaceId: workspace, authorUserId: member, title: 'Response probe' })).id;
    for (const [index, name] of names.entries()) {
      await env.DB.prepare(`INSERT INTO entities (id, workspace_id, name, kind, status, created_at, updated_at) VALUES (?, ?, ?, 'lead', 'warm', ?, ?)`)
        .bind(entityId(index), workspace, name, now, now).run();
    }
    for (const [index, content] of ['Prefers email.', 'Prefers WhatsApp.'].entries()) {
      await env.DB.prepare(`INSERT INTO memory_entries (id, workspace_id, scope, subject_id, category, content, status, observed_at, created_at, business_revision) VALUES (?, ?, 'entity', ?, 'communication_preference', ?, 'active', ?, ?, 0)`)
        .bind(`memory_response_${index}`, workspace, entityId(index), content, now, now).run();
    }
  });

  it('swapping entity-note ownership produces an identical model context', async () => {
    const before = await context('Compare Cedar Works and Bluebird Coffee Ltd.');
    expect(before.activeNotes.map(note => note.subjectId)).toEqual([entityId(0), entityId(1)]);
    expect(before.systemPrompt).toContain('Prefers email.');
    expect(before.systemPrompt).toContain('Prefers WhatsApp.');
    await env.DB.prepare(`UPDATE memory_entries SET subject_id = CASE subject_id WHEN ? THEN ? ELSE ? END WHERE workspace_id = ? AND id IN (?, ?)`)
      .bind(entityId(0), entityId(1), entityId(0), workspace, 'memory_response_0', 'memory_response_1').run();
    const after = await context('Compare Cedar Works and Bluebird Coffee Ltd.');
    expect(after.activeNotes.map(note => note.subjectId)).toEqual([entityId(1), entityId(0)]);
    expect(after.systemPrompt).toBe(before.systemPrompt);
    expect(before.systemPrompt).not.toContain('Cedar Works');
    expect(before.systemPrompt).not.toContain('Bluebird Coffee Ltd');
  });

  it('natural-question search drops the entity and subject after six filler terms', () => {
    const query = sanitizeFtsQuery("Hey can you remind me what we agreed about Bluebird's payment terms?");
    expect(query).toBe('"Hey"* OR "can"* OR "you"* OR "remind"* OR "me"* OR "what"*');
    expect(query).not.toMatch(/Bluebird|payment|terms/i);
  });

  it('stored older text is absent from the bounded automatic context', async () => {
    for (let sequence = 1; sequence <= 12; sequence++) {
      await env.DB.prepare(`INSERT INTO chat_messages (id, workspace_id, chat_id, author_user_id, author_kind, channel, content_text, sequence, created_at, updated_at) VALUES (?, ?, ?, ?, 'member', 'web', ?, ?, ?, ?)`)
        .bind(`message_response_${sequence}`, workspace, chat, member, sequence === 1 ? 'Earlier unfiled discussion: consider a staged deposit.' : `Later conversation ${sequence}`, sequence, now, now).run();
    }
    const assembled = await context('What did we discuss earlier?');
    expect(assembled.recentMessages).toHaveLength(10);
    expect(assembled.recentMessages.some(message => message.text.includes('staged deposit'))).toBe(false);
    expect(await env.DB.prepare(`SELECT id FROM chat_messages WHERE workspace_id = ? AND id = ?`).bind(workspace, 'message_response_1').first()).not.toBeNull();
  });

  it('rules out the suspected bulk-confirmation issue for read-only entity queries', async () => {
    const { result, runId, fake } = await dispatch({ scripts: [{ kind: 'tool_calls', calls: names.map((_, index) => ({ callId: `read_${index}`, name: 'query', args: { resource: 'entities', filters: { entity_id: entityId(index) } } })) }, { kind: 'text', text: 'Compared the four leads.' }] }, 'Compare these four leads.', 'response_bulk_read');
    expect(result.status).toBe('completed');
    const pending = await env.DB.prepare(`SELECT intended_operation, question FROM pending_clarifications WHERE run_id = ?`).bind(runId).first<{ intended_operation: string; question: string }>();
    expect(pending).toBeNull();
    expect(fake.calls).toHaveLength(2);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?`).bind(workspace).first<{ count: number }>())?.count).toBe(0);
  });

  it('an empty successful provider answer becomes a saved empty completed reply', async () => {
    const { result, runId } = await dispatch({ scripts: [{ kind: 'text', text: '' }] }, 'Hello.', 'response_empty');
    expect(result.status).toBe('completed');
    expect((await env.DB.prepare(`SELECT status FROM agent_runs WHERE id = ?`).bind(runId).first<{ status: string }>())?.status).toBe('succeeded');
    const reply = await env.DB.prepare(`SELECT content_text FROM chat_messages WHERE workspace_id = ? AND run_id = ? AND author_kind = 'system'`).bind(workspace, runId).first<{ content_text: string }>();
    expect(reply).not.toBeNull();
    expect(reply?.content_text).toBe('');
  });

  it('direct memory reads return forgotten content that automatic context excludes', async () => {
    await env.DB.prepare(`UPDATE memory_entries SET status = 'forgotten' WHERE workspace_id = ? AND id = ?`)
      .bind(workspace, 'memory_response_0').run();
    const assembled = await context('Cedar Works');
    expect(assembled.activeNotes.some(note => note.id === 'memory_response_0')).toBe(false);
    const read = await executeAgentTool({ db: env.DB, workspaceId: workspace, actorUserId: member, actionId: 'response_forgotten_read', sourceTrust: 'member', sourceText: 'Recall the earlier preference.', toolName: 'get_memory', toolArgs: { memory_id: 'memory_response_0' } });
    expect(read.status).toBe('applied');
    expect(read.data).toMatchObject({ status: 'forgotten', content: 'Prefers email.' });
  });
});

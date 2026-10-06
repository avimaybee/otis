import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
// @ts-expect-error vite raw import
import migration0001Sql from '../../../migrations/0001_identity.sql?raw';
// @ts-expect-error vite raw import
import migration0002Sql from '../../../migrations/0002_conversations_sources.sql?raw';
// @ts-expect-error vite raw import
import migration0003Sql from '../../../migrations/0003_ledger.sql?raw';
// @ts-expect-error vite raw import
import migration0004Sql from '../../../migrations/0004_lifecycle_settings.sql?raw';
// @ts-expect-error vite raw import
import migration0005Sql from '../../../migrations/0005_actor_dispatch.sql?raw';
// @ts-expect-error vite raw import
import migration0006Sql from '../../../migrations/0006_actor_hardening.sql?raw';
// @ts-expect-error vite raw import
import migration0007Sql from '../../../migrations/0007_outbox_claim_owner.sql?raw';
// @ts-expect-error vite raw import
import migration0008Sql from '../../../migrations/0008_memory_and_agent_runs.sql?raw';
// @ts-expect-error vite raw import
import migration0009Sql from '../../../migrations/0009_thinking_controls.sql?raw';
// @ts-expect-error vite raw import
import migration0010Sql from '../../../migrations/0010_outbox_retry_at.sql?raw';
// @ts-expect-error vite raw import
import migration0011Sql from '../../../migrations/0011_link_workspace_intent.sql?raw';
// @ts-expect-error vite raw import
import migration0012Sql from '../../../migrations/0012_voice_media.sql?raw';
// @ts-expect-error vite raw import
import migration0015Sql from '../../../migrations/0015_message_image_attachments.sql?raw';

import { AgentHandler } from '../src/agent/handler.js';
import { dispatchOutboxItem, dispatchWorkspace, type TurnContext, type TurnHandler } from '../src/actor/dispatch.js';
import { publishAgentActivity } from '../src/agent/activity.js';
import { liveChatBus } from '../src/chat/liveBus.js';
import worker from '../src/index.js';
import { acceptWebMessage, createChat } from '../src/inbox/repository.js';
import { handleCreateMessage } from '../src/routes/chats.js';
import { FakeProviderAdapter } from '@otis/agent';
import { sha256 } from '@otis/identity';
import { AUTH_BOUNDS } from '@otis/contracts';

/**
 * 008B promptness and streaming proof (workerd, fake provider transport).
 * An accepted message in an otherwise idle workspace reaches a terminal run
 * through dispatchWorkspace alone: no cron tick, no second dispatch, no live
 * provider call. Text and thinking flush as persisted activity rows.
 */
describe('Dispatch promptness and stream publication (008B workerd)', () => {
  const ws = 'ws-dispatch-promptness';
  const aviId = 'usr_avi_prompt';
  let chatAvi: string;
  const nowIso = new Date().toISOString();
  const defaultTestLimits = { maxDailyActions: 50, maxRoundsPerRun: 10 };

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

  async function activityRows(runId: string, type: string): Promise<Array<{ id: string; payload: Record<string, unknown> }>> {
    const rows = await env.DB.prepare(
      `SELECT id, payload_json FROM run_activity WHERE run_id = ? AND type = ? ORDER BY cursor ASC`,
    )
      .bind(runId, type)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map(row => ({
      id: String(row['id']),
      payload: JSON.parse(String(row['payload_json'] ?? '{}')) as Record<string, unknown>,
    }));
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

  beforeAll(async () => {
    for (const sql of [
      migration0001Sql, migration0002Sql, migration0003Sql, migration0004Sql,
      migration0005Sql, migration0006Sql, migration0007Sql, migration0008Sql,
      migration0009Sql,
      migration0010Sql, migration0011Sql,
      migration0012Sql,
      migration0015Sql,
    ]) {
      for (const stmt of splitSqlStatements(sql)) {
        await env.DB.prepare(stmt).run();
      }
    }
    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(aviId, `fb_${aviId}`, 'avi.prompt@kerning.test', 'Avi Prompt', nowIso, nowIso)
      .run();
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
       VALUES (?, 'Promptness WS', ?, 0, 1, ?, ?)`,
    )
      .bind(ws, aviId, nowIso, nowIso)
      .run();
    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)`,
    )
      .bind(ws, aviId, nowIso, nowIso, nowIso)
      .run();
    chatAvi = (await createChat(env.DB, { workspaceId: ws, authorUserId: aviId, title: 'Prompt Chat' })).id;
  });

  beforeEach(async () => {
    await env.DB.prepare('UPDATE workspaces SET lease_owner = NULL, lease_attempt_id = NULL, lease_expires_at = NULL WHERE id = ?').bind(ws).run();
  });

  it('starts an idle accepted input to terminal without cron and never twice', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws, chatId: chatAvi, userId: aviId, clientMessageId: 'msg-prompt-1', text: 'Hello prompt run',
    });
    const pending = await env.DB.prepare(
      `SELECT id FROM outbox WHERE workspace_id = ? AND destination = 'workspace_actor' AND status = 'pending'`,
    ).bind(ws).all();
    expect((pending.results ?? []).length).toBeGreaterThan(0);

    const fakeAdapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [{ kind: 'text', text: 'Prompt answer complete.' }],
    });
    const handler = new AgentHandler({ providerAdapter: fakeAdapter, limits: defaultTestLimits });
    // The queue consumer calls exactly this; cron is never invoked here.
    const first = await dispatchWorkspace(env.DB, ws, { budget: 3, handler });
    expect(first.processed).toBeGreaterThan(0);

    const run = await env.DB.prepare(`SELECT status FROM agent_runs WHERE id = ?`).bind(accepted.run_id).first<{ status: string }>();
    expect(run?.status).toBe('succeeded');
    const finished = await activityRows(accepted.run_id, 'run_finished');
    expect(finished.length).toBe(1);
    expect(String((finished[0]!.payload as Record<string, unknown>)['status'] ?? '')).toBe('succeeded');
    const chunks = await activityRows(accepted.run_id, 'text_chunk');
    expect(chunks.map(row => String(row.payload['text'] ?? '')).join('')).toBe('Prompt answer complete.');
    // Completion is a metadata record referencing the persisted reply, not a
    // repeated full-text preview chunk.
    const saved = await activityRows(accepted.run_id, 'answer_saved');
    expect(saved).toHaveLength(1);
    expect(String((saved[0]!.payload as Record<string, unknown>)['message_id'] ?? '')).toBe(`reply_${accepted.run_id}`);
    expect(String((finished[0]!.payload as Record<string, unknown>)['message_id'] ?? '')).toBe(`reply_${accepted.run_id}`);
    const answer = await env.DB.prepare(`SELECT content_text FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`).bind(accepted.run_id).first<{ content_text: string }>();
    expect(answer?.content_text).toContain('Prompt answer complete.');

    const activityCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM run_activity WHERE run_id = ?`).bind(accepted.run_id).first<{ n: number }>();
    const second = await dispatchWorkspace(env.DB, ws, { budget: 3, handler });
    expect(second.processed).toBe(0);
    const activityCountAfter = await env.DB.prepare(`SELECT COUNT(*) AS n FROM run_activity WHERE run_id = ?`).bind(accepted.run_id).first<{ n: number }>();
    expect(activityCountAfter?.n).toBe(activityCount?.n);
    // The accepted outbox item is itself settled, not left pending.
    const item = await env.DB.prepare(`SELECT status FROM outbox WHERE id = ?`).bind(await outboxIdForRun(accepted.run_id)).first<{ status: string }>();
    expect(item?.status).toBe('delivered');
  });

  it('publishes short answers and thinking batches with block metadata', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws, chatId: chatAvi, userId: aviId, clientMessageId: 'msg-prompt-2', text: 'Think then answer',
    });
    const fakeAdapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [
        {
          kind: 'thinking',
          blocks: [
            { blockId: 's0', snapshot: 'Considering the visit', deltas: [' and the Friday', ' promise.'] },
            { blockId: 's1', deltas: ['Double-checking dates.'] },
          ],
          finalText: 'Thai Shop is warm.',
        },
      ],
    });
    const handler = new AgentHandler({ providerAdapter: fakeAdapter, limits: defaultTestLimits });
    const result = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });
    expect(result.status).toBe('completed');

    const thinking = await activityRows(accepted.run_id, 'reasoning_summary');
    expect(thinking.length).toBeGreaterThan(0);
    for (const row of thinking) {
      expect(typeof row.payload['block_id']).toBe('string');
      expect(row.payload['content_kind']).toBe('summary');
      expect(['append', 'snapshot']).toContain(row.payload['mode']);
      expect(['streaming', 'complete', 'interrupted', 'truncated']).toContain(row.payload['state']);
    }
    const states = thinking.map(row => row.payload['state']);
    expect(states[states.length - 1]).not.toBe('streaming');
    const completeText = thinking
      .filter(row => typeof row.payload['text'] === 'string' && (row.payload['text'] as string).length > 0)
      .map(row => row.payload['text'] as string)
      .join('');
    expect(completeText).toContain('Considering the visit');
    expect(completeText).toContain('Double-checking dates.');
    const blockIds = new Set(thinking.map(row => row.payload['block_id']));
    expect(blockIds.has('s0')).toBe(true);
    expect(blockIds.has('s1')).toBe(true);
  });

  it('returns a useful scoped error when no model can run', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws, chatId: chatAvi, userId: aviId, clientMessageId: 'msg-prompt-3', text: 'No credential run',
    });
    // Real handler, no injected adapter, no provisioned credential.
    const handler = new AgentHandler({ limits: defaultTestLimits });
    const result = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('model_unavailable');
    const run = await env.DB.prepare(`SELECT status FROM agent_runs WHERE id = ?`).bind(accepted.run_id).first<{ status: string }>();
    expect(run?.status).toBe('failed');
    const failures = await activityRows(accepted.run_id, 'partial_failure');
    expect(failures.length).toBe(1);
    expect(String(failures[0]!.payload['error_code'] ?? '')).toContain('model_unavailable');
  });

  it('wakes an idle accepted input through the HTTP acceptance actor hint and queue forwarding without cron', async () => {
    // Owning route/actor proof: production POST acceptance wakes the workspace
    // actor directly (no Queue batching on the interactive path), and the
    // queue consumer forwards each workspace once to that same actor. No cron,
    // no direct acceptWebMessage shortcut, fake provider transport only.
    const rawToken = 'promptness-route-token';
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
       VALUES ('sess_prompt_route', ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash`,
    )
      .bind(await sha256(rawToken), aviId, now, new Date(Date.now() + 3600 * 1000).toISOString(), now)
      .run();

    const actorCalls: unknown[] = [];
    const queueSends: unknown[] = [];
    const waited: Promise<unknown>[] = [];
    const routeEnv = {
      ...env,
      WORKSPACE_ACTOR: {
        idFromName: (name: string) => ({ name }),
        get: (_id: unknown) => ({
          fetch: async (req: Request) => {
            actorCalls.push(await req.json());
            return new Response(JSON.stringify({ status: 'accepted' }), { status: 202 });
          },
        }),
      },
      DISPATCH_QUEUE: {
        send: async (body: unknown) => {
          queueSends.push(body);
        },
      },
    } as unknown as typeof env;
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => {
        waited.push(promise);
      },
    } as unknown as ExecutionContext;

    const clientMessageId = `msg-prompt-route-${Date.now()}`;
    const request = new Request(`http://localhost/api/workspaces/${ws}/chats/${chatAvi}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${AUTH_BOUNDS.COOKIE_NAME}=${rawToken}`,
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
        origin: 'http://localhost',
      },
      body: JSON.stringify({ text: 'Route wake-up proof', client_message_id: clientMessageId }),
    });
    const response = await handleCreateMessage(request, routeEnv, ws, chatAvi, 'req-prompt-route', ctx);
    expect(response.status).toBe(202);
    const accepted = (await response.json()) as { run_id: string; message_id: string };
    expect(accepted.run_id).toBeTruthy();

    await Promise.all(waited);
    // Interactive acceptance must wake the actor directly and must not pay
    // Queue batching.
    expect(actorCalls).toContainEqual(expect.objectContaining({ action: 'dispatch', workspace_id: ws }));
    expect(queueSends).toEqual([]);

    const pending = await env.DB.prepare(
      `SELECT id FROM outbox WHERE workspace_id = ? AND destination = 'workspace_actor' AND status = 'pending'`,
    ).bind(ws).all();
    expect((pending.results ?? []).length).toBeGreaterThan(0);

    // What the queue consumer now does for wake-up messages: coalesce
    // duplicates and forward each workspace once to its actor. The actor runs
    // the installed test handler to a terminal reply.
    const fakeAdapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [{ kind: 'text', text: 'Route wake-up answer.' }],
    });
    const handler = new AgentHandler({ providerAdapter: fakeAdapter, limits: defaultTestLimits });
    (env as unknown as Record<string, unknown>).DISPATCH_TEST_HANDLER = handler;
    try {
      await worker.queue(
        { messages: [{ body: { workspace_id: ws } }, { body: { workspace_id: ws } }, { body: {} }] } as unknown as MessageBatch<{
          workspace_id?: unknown;
        }>,
        env,
      );
    } finally {
      delete (env as unknown as Record<string, unknown>).DISPATCH_TEST_HANDLER;
    }

    const run = await env.DB.prepare(`SELECT status FROM agent_runs WHERE id = ?`).bind(accepted.run_id).first<{ status: string }>();
    expect(run?.status).toBe('succeeded');
    const answer = await env.DB.prepare(`SELECT content_text FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`).bind(accepted.run_id).first<{ content_text: string }>();
    expect(answer?.content_text).toContain('Route wake-up answer.');
  });

  it('acks async actor wakes fast, dedupes in-flight work, and completes in background', async () => {    // Production wake semantics: async dispatch returns 202 immediately and
    // the actor owns continued execution via state.waitUntil, so the Worker
    // waitUntil never holds a long model turn past its post-response window.
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws, chatId: chatAvi, userId: aviId, clientMessageId: `msg-prompt-async-${Date.now()}`, text: 'Async wake proof',
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let calls = 0;
    const gated: TurnHandler = {
      name: 'gated-async',
      async runTurn() {
        calls++;
        if (calls === 1) await gate;
        return { kind: 'completed', replyText: 'Async actor answer.' };
      },
    };
    (env as unknown as Record<string, unknown>).DISPATCH_TEST_HANDLER = gated;
    try {
      const stub = env.WORKSPACE_ACTOR.get(env.WORKSPACE_ACTOR.idFromName(ws));
      const wake = () => stub.fetch(new Request('https://actor/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dispatch', workspace_id: ws, budget: 5 }),
      }));
      const first = await wake();
      expect(first.status).toBe(202);
      expect(await first.json()).toMatchObject({ status: 'accepted', deduped: false });
      const second = await wake();
      expect(second.status).toBe(202);
      expect(await second.json()).toMatchObject({ status: 'accepted', deduped: true });
      releaseGate();
      const started = Date.now();
      let status: string | undefined;
      while (Date.now() - started < 5000) {
        const row = await env.DB.prepare(`SELECT status FROM agent_runs WHERE id = ?`).bind(accepted.run_id).first<{ status: string }>();
        status = row?.status;
        if (status === 'succeeded') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(status).toBe('succeeded');
    } finally {
      delete (env as unknown as Record<string, unknown>).DISPATCH_TEST_HANDLER;
    }
  });

  it('corrects a rejected tool call in-run without replaying the committed write', async () => {
    // Round 1 applies one memory write and rejects a second call for a
    // shape error; round 2 carries the corrected call; round 3 answers.
    // The run completes and the first write exists exactly once.
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws, chatId: chatAvi, userId: aviId, clientMessageId: 'msg-correct-1', text: 'Remember two facts',
    });
    const fakeAdapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [
        {
          kind: 'tool_calls',
          calls: [
            { callId: 'fix_c1', name: 'remember_context', args: { scope: 'workspace', category: 'other_context', content: 'First durable fact.' } },
            { callId: 'fix_c2', name: 'remember_context', args: { scope: 'workspace', subject_id: 'oops', category: 'other_context', content: 'Bad shape.' } },
          ],
        },
        {
          kind: 'tool_calls',
          calls: [
            { callId: 'fix_c3', name: 'remember_context', args: { scope: 'workspace', category: 'other_context', content: 'Corrected fact.' } },
          ],
        },
        { kind: 'text', text: 'Both facts saved.' },
      ],
    });
    const handler = new AgentHandler({ providerAdapter: fakeAdapter, limits: defaultTestLimits, maxRoundsPerSlice: 5 });
    for (let i = 0; i < 4; i++) {
      const result = await dispatchWorkspace(env.DB, ws, { budget: 3, handler });
      if (result.processed === 0) break;
    }
    const status = (await env.DB.prepare(`SELECT status FROM agent_runs WHERE id = ?`).bind(accepted.run_id).first<{ status: string }>())?.status;
    expect(status).toBe('succeeded');

    const first = await env.DB.prepare(`SELECT COUNT(*) AS n FROM memory_entries WHERE workspace_id = ? AND content = 'First durable fact.'`).bind(ws).first<{ n: number }>();
    expect(Number(first?.n)).toBe(1);
    const corrected = await env.DB.prepare(`SELECT COUNT(*) AS n FROM memory_entries WHERE workspace_id = ? AND content = 'Corrected fact.'`).bind(ws).first<{ n: number }>();
    expect(Number(corrected?.n)).toBe(1);

    // The shape rejection is recorded as typed feedback, not a run failure.
    const rejection = await env.DB.prepare(
      `SELECT result_json FROM run_steps WHERE run_id = ? AND result_json LIKE '%invalid_subject%'`,
    ).bind(accepted.run_id).first<{ result_json: string }>();
    expect(rejection?.result_json).toContain('invalid_subject');
  });

  it('streams transient preview frames live with one durable chunk per round', async () => {
    // Multi-delta round: live frames stream with no per-frame D1 write, and
    // the durable remainder persists exactly once on close.
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws, chatId: chatAvi, userId: aviId, clientMessageId: `msg-prompt-preview-${Date.now()}`, text: 'Stream preview proof',
    });
    const frames: Array<{ text: string; seq: number; round: number }> = [];
    const unsubscribe = liveChatBus.subscribe(ws, chatAvi, (event) => {
      const data = event.data as { type?: string; payload?: { text?: unknown; round_index?: unknown; seq?: unknown } };
      if (data.type === 'text_preview' && data.payload && typeof data.payload.text === 'string') {
        frames.push({
          text: data.payload.text,
          seq: Number(data.payload.seq),
          round: Number(data.payload.round_index),
        });
      }
    });
    try {
      const fakeAdapter = new FakeProviderAdapter({
        provider: 'gemini',
        scripts: [{ kind: 'text_chunks', chunks: ['Hello ', 'world.'] }],
      });
      const handler = new AgentHandler({ providerAdapter: fakeAdapter, limits: defaultTestLimits });
      await dispatchWorkspace(env.DB, ws, { budget: 3, handler });
      expect(frames.length).toBeGreaterThanOrEqual(1);
      expect(frames[frames.length - 1]!.text).toBe('Hello world.');
      expect(frames.every((frame, index) => index === 0 || frame.seq > frames[index - 1]!.seq)).toBe(true);
    } finally {
      unsubscribe();
    }
    const chunks = await activityRows(accepted.run_id, 'text_chunk');
    expect(chunks.map(row => String(row.payload['text'] ?? '')).join('')).toBe('Hello world.');
  });

  it('republishing the same preview key writes and broadcasts exactly once', async () => {
    // The single-batch publication is idempotent: a retried flush inserts no
    // second row, burns no cursor, and emits no second live event.
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws, chatId: chatAvi, userId: aviId, clientMessageId: `msg-prompt-idem-${Date.now()}`, text: 'Idempotency proof',
    });
    const ctx = { db: env.DB, workspaceId: ws, runId: accepted.run_id, chatId: chatAvi } as TurnContext;
    const events: unknown[] = [];
    const unsubscribe = liveChatBus.subscribe(ws, chatAvi, (event) => void events.push(event));
    try {
      await publishAgentActivity(ctx, 'r0_text0', 'text_chunk', { text: 'once', round_index: 0 });
      const cursorAfterFirst = await env.DB.prepare(`SELECT activity_cursor FROM chats WHERE id = ?`).bind(chatAvi).first<{ activity_cursor: number }>();
      await publishAgentActivity(ctx, 'r0_text0', 'text_chunk', { text: 'once', round_index: 0 });
      const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM run_activity WHERE id = ?`).bind(`act_${accepted.run_id}_r0_text0`).all();
      expect((rows.results ?? [])).toHaveLength(1);
      const cursorAfterSecond = await env.DB.prepare(`SELECT activity_cursor FROM chats WHERE id = ?`).bind(chatAvi).first<{ activity_cursor: number }>();
      expect(cursorAfterSecond?.activity_cursor).toBe(cursorAfterFirst?.activity_cursor);
      expect(events).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });
});

import { ALL_MIGRATION_SQL } from './migrations.js';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

import { AgentHandler } from '../src/agent/handler.js';
import {
  dispatchOutboxItem,
  resumeRun,
  type LoadedRun,
} from '../src/actor/dispatch.js';
import { acceptWebMessage, createChat } from '../src/inbox/repository.js';
import { type TurnInput, type ProviderAdapter, FakeProviderAdapter, GeminiInteractionsAdapter, PRODUCTION_REGISTRY } from '@otis/agent';
import { resolveProviderRawKey, runProviderTurn } from '../src/providers/service.js';

describe('Worker Agent Loop, Recovery & Clarification Integration (006B workerd)', () => {
  const ws = 'ws-agent-loop-test';
  const aviId = 'usr_avi_loop';
  const hunorId = 'usr_hunor_loop';
  let chatAvi: string;
  let chatHunor: string;
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
      if (/\bBEGIN\b/i.test(line)) {
        inTrigger = true;
      }
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

    if (current.trim().length > 0) {
      statements.push(current.trim());
    }
    return statements;
  }

  async function loadRunById(runId: string): Promise<LoadedRun> {
    const row = await env.DB.prepare(
      `SELECT id, workspace_id, chat_id, source_message_id, source_job_id, status, attempt_id, lease_fence
       FROM agent_runs WHERE id = ?`,
    )
      .bind(runId)
      .first<Record<string, unknown>>();
    if (!row) throw new Error(`run ${runId} missing`);
    return {
      id: String(row['id']),
      workspace_id: String(row['workspace_id']),
      chat_id: String(row['chat_id']),
      source_message_id: row['source_message_id'] ? String(row['source_message_id']) : null,
      source_job_id: row['source_job_id'] ? String(row['source_job_id']) : null,
      status: String(row['status']),
      attempt_id: row['attempt_id'] ? String(row['attempt_id']) : null,
      lease_fence: Number(row['lease_fence'] ?? 0),
    };
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
    for (const sql of ALL_MIGRATION_SQL) {
      for (const stmt of splitSqlStatements(sql)) {
        await env.DB.prepare(stmt).run();
      }
    }

    // Seed test users
    for (const [id, email, name] of [
      [aviId, 'avi.loop@kerning.test', 'Avi Loop'],
      [hunorId, 'hunor.loop@kerning.test', 'Hunor Loop'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(id, `fb_${id}`, email, name, nowIso, nowIso)
        .run();
    }

    // Seed test workspace
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
       VALUES (?, 'Kerning Agent WS', ?, 0, 1, ?, ?)`
    )
      .bind(ws, aviId, nowIso, nowIso)
      .run();

    for (const [user, role] of [
      [aviId, 'owner'],
      [hunorId, 'member'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(ws, user, role, nowIso, nowIso, nowIso)
        .run();
    }

    chatAvi = (await createChat(env.DB, { workspaceId: ws, authorUserId: aviId, title: 'Avi Loop Chat' })).id;
    chatHunor = (await createChat(env.DB, { workspaceId: ws, authorUserId: hunorId, title: 'Hunor Loop Chat' })).id;
  });

  beforeEach(async () => {
    await env.DB.prepare('UPDATE workspaces SET lease_owner = NULL, lease_attempt_id = NULL, lease_expires_at = NULL WHERE id = ?').bind(ws).run();
  });

  it('executes a read-only question and completes with verified response', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'msg-client-ro-1',
      text: 'What is our quote policy?',
    });

    const fakeAdapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [
        {
          kind: 'text',
          text: 'Our quote policy is that quotes are stored in integer minor units in RON.',
        },
      ],
    });

    const handler = new AgentHandler({ providerAdapter: fakeAdapter, limits: defaultTestLimits });
    const result = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });

    expect(result.status).toBe('completed');
    const run = await loadRunById(accepted.run_id);
    expect(run.status).toBe('succeeded');

    // Verify reply in chat_messages
    const reply = await env.DB.prepare(
      `SELECT content_text, author_kind FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`
    ).bind(accepted.run_id).first<{ content_text: string; author_kind: string }>();
    expect(reply?.content_text).toContain('integer minor units in RON');
  });

  it('executes multi-round tools: round 1 proposes tool calls, round 2 returns final text with history', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'msg-client-mr-1',
      text: 'Create lead Bakery Delight',
    });

    const fakeAdapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [
        {
          kind: 'tool_calls',
          calls: [
            {
              callId: 'call_create_bakery',
              name: 'upsert_entity',
              args: { name: 'Bakery Delight' },
            },
          ],
        },
        {
          kind: 'text',
          text: 'I have created the Bakery Delight lead in your pipeline.',
        },
      ],
    });

    const handler = new AgentHandler({ providerAdapter: fakeAdapter, maxRoundsPerSlice: 3, limits: defaultTestLimits });
    const result = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });

    expect(result.status).toBe('completed');
    const run = await loadRunById(accepted.run_id);
    expect(run.status).toBe('succeeded');

    // Verify entity created in D1
    const entity = await env.DB.prepare(
      `SELECT name FROM entities WHERE workspace_id = ? AND name = 'Bakery Delight'`
    ).bind(ws).first<{ name: string }>();
    expect(entity?.name).toBe('Bakery Delight');

    // Verify fake was called twice (round 1 tool calls, round 2 final text)
    expect(fakeAdapter.calls.length).toBe(2);
  });

  it('production-shaped Gemini continuation: strict endpoint accepts one linked pending result and no replay', async () => {
    const toolCallSse = [
      'event: interaction.created\n',
      'data: {"interaction":{"id":"v1_cont_1","status":"in_progress"},"event_type":"interaction.created"}\n\n',
      'event: step.start\n',
      'data: {"index":0,"step":{"type":"function_call","id":"call_cont_1","name":"upsert_entity","arguments":{}},"event_type":"step.start"}\n\n',
      'event: step.delta\n',
      'data: {"index":0,"delta":{"type":"arguments_delta","arguments":"{\\"name\\":\\"Continuation Probe\\"}"},"event_type":"step.delta"}\n\n',
      'event: step.stop\n',
      'data: {"index":0,"event_type":"step.stop"}\n\n',
      'event: interaction.completed\n',
      'data: {"interaction":{"id":"v1_cont_1","status":"requires_action","usage":{}},"event_type":"interaction.completed"}\n\n',
      'event: done\n',
      'data: [DONE]\n\n',
    ].join('');
    const textSse = [
      'event: interaction.created\n',
      'data: {"interaction":{"id":"v1_cont_2","status":"in_progress"},"event_type":"interaction.created"}\n\n',
      'event: step.start\n',
      'data: {"index":0,"step":{"type":"model_output"},"event_type":"step.start"}\n\n',
      'event: step.delta\n',
      'data: {"index":0,"delta":{"type":"text","text":"Saved. Continuation complete."},"event_type":"step.delta"}\n\n',
      'event: step.stop\n',
      'data: {"index":0,"event_type":"step.stop"}\n\n',
      'event: interaction.completed\n',
      'data: {"interaction":{"id":"v1_cont_2","status":"completed","usage":{}},"event_type":"interaction.completed"}\n\n',
      'event: done\n',
      'data: [DONE]\n\n',
    ].join('');

    const requests: Array<Record<string, unknown>> = [];
    // Strict fake endpoint: rejects any invalid continuation shape with a
    // real HTTP400 instead of accepting a permissive replay.
    const strictFetch = async (_url: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push(body);
      const blocks = (body['input'] as Array<Record<string, unknown>>) ?? [];
      if (requests.length === 1) {
        if (body['previous_interaction_id'] !== undefined) {
          return new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT' } }), { status: 400 });
        }
        if (!blocks.some((block) => block['type'] === 'user_input')) {
          return new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT' } }), { status: 400 });
        }
        return new Response(toolCallSse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      const resultBlocks = blocks.filter((block) => block['type'] === 'function_result');
      const invalid =
        body['previous_interaction_id'] !== 'v1_cont_1' ||
        blocks.some((block) => block['type'] === 'function_call') ||
        blocks.some((block) => block['type'] === 'model_output') ||
        blocks.some((block) => block['type'] === 'user_input') ||
        resultBlocks.length !== 1 ||
        resultBlocks[0]?.['call_id'] !== 'call_cont_1' ||
        body['system_instruction'] === undefined ||
        !Array.isArray(body['tools']);
      if (invalid) {
        return new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT' } }), { status: 400 });
      }
      return new Response(textSse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };

    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'msg-client-cont-qa1',
      text: 'Create the Continuation Probe lead',
    });
    const adapter = new GeminiInteractionsAdapter({ fetchFn: strictFetch, apiKey: 'test-gemini-key' });
    const handler = new AgentHandler({ providerAdapter: adapter, maxRoundsPerSlice: 3, limits: defaultTestLimits });
    const result = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });

    expect(result.status).toBe('completed');
    expect(requests).toHaveLength(2);
    expect((await loadRunById(accepted.run_id)).status).toBe('succeeded');
    // Exactly one committed effect/receipt for the whole turn.
    expect(
      Number(
        (await env.DB
          .prepare(`SELECT COUNT(*) AS n FROM action_receipts WHERE workspace_id = ? AND run_id = ?`)
          .bind(ws, accepted.run_id)
          .first<{ n: number }>())?.n,
      ),
    ).toBe(1);
    expect(
      Number(
        (await env.DB
          .prepare(`SELECT COUNT(*) AS n FROM entities WHERE workspace_id = ? AND name = 'Continuation Probe'`)
          .bind(ws)
          .first<{ n: number }>())?.n,
      ),
    ).toBe(1);
    const reply = await env.DB
      .prepare(`SELECT content_text FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`)
      .bind(accepted.run_id)
      .first<{ content_text: string }>();
    expect(reply?.content_text).toContain('Continuation complete');
  });

  it('a real provider400 after a committed effect stays partial with one receipt', async () => {
    const toolCallSse = [
      'event: interaction.created\n',
      'data: {"interaction":{"id":"v1_partial_1","status":"in_progress"},"event_type":"interaction.created"}\n\n',
      'event: step.start\n',
      'data: {"index":0,"step":{"type":"function_call","id":"call_partial_1","name":"upsert_entity","arguments":{}},"event_type":"step.start"}\n\n',
      'event: step.delta\n',
      'data: {"index":0,"delta":{"type":"arguments_delta","arguments":"{\\"name\\":\\"Partial Probe\\"}"},"event_type":"step.delta"}\n\n',
      'event: step.stop\n',
      'data: {"index":0,"event_type":"step.stop"}\n\n',
      'event: interaction.completed\n',
      'data: {"interaction":{"id":"v1_partial_1","status":"requires_action","usage":{}},"event_type":"interaction.completed"}\n\n',
      'event: done\n',
      'data: [DONE]\n\n',
    ].join('');
    let calls = 0;
    const strictFetch = async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        return new Response(toolCallSse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT' } }), { status: 400 });
    };

    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'msg-client-partial-qa1',
      text: 'Create the Partial Probe lead',
    });
    const adapter = new GeminiInteractionsAdapter({ fetchFn: strictFetch, apiKey: 'test-gemini-key' });
    const handler = new AgentHandler({ providerAdapter: adapter, maxRoundsPerSlice: 3, limits: defaultTestLimits });
    const result = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });

    expect(result.status).toBe('failed');
    const run = await loadRunById(accepted.run_id);
    expect(run.status).toBe('partial');
    expect(
      Number(
        (await env.DB
          .prepare(`SELECT COUNT(*) AS n FROM action_receipts WHERE workspace_id = ? AND run_id = ?`)
          .bind(ws, accepted.run_id)
          .first<{ n: number }>())?.n,
      ),
    ).toBe(1);
    expect(
      Number(
        (await env.DB
          .prepare(`SELECT COUNT(*) AS n FROM entities WHERE workspace_id = ? AND name = 'Partial Probe'`)
          .bind(ws)
          .first<{ n: number }>())?.n,
      ),
    ).toBe(1);
  });

  it('sends each clarification answer once by durable identity across stateful continuations and restarts', async () => {
    // Ledger date interpretation needs the member timezone.
    await env.DB
      .prepare(
        `INSERT INTO member_settings (workspace_id, user_id, brief_enabled, brief_timezone, brief_channel, preferred_language, created_at, updated_at)
         VALUES (?, ?, 0, 'Europe/Bucharest', 'web', 'en', ?, ?)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET brief_timezone = excluded.brief_timezone, updated_at = excluded.updated_at`,
      )
      .bind(ws, aviId, nowIso, nowIso)
      .run();

    const sse = (blocks: string[], interactionId: string, status: string) =>
      [
        'event: interaction.created\n',
        `data: {"interaction":{"id":"${interactionId}","status":"in_progress"},"event_type":"interaction.created"}\n\n`,
        ...blocks,
        'event: interaction.completed\n',
        `data: {"interaction":{"id":"${interactionId}","status":"${status}","usage":{}},"event_type":"interaction.completed"}\n\n`,
        'event: done\n',
        'data: [DONE]\n\n',
      ].join('');
    const functionCall = (index: number, id: string, name: string, args: unknown) =>
      `event: step.start\ndata: {"index":${index},"step":{"type":"function_call","id":"${id}","name":"${name}","arguments":${JSON.stringify(args)}},"event_type":"step.start"}\n\n` +
      `event: step.stop\ndata: {"index":${index},"event_type":"step.stop"}\n\n`;
    const sse1 = sse([functionCall(0, 'call_q1', 'create_task', { title: 'Q1 task' })], 'v1_q1', 'requires_action');
    const sse2 = sse(
      [
        functionCall(0, 'call_effect', 'upsert_entity', { name: 'Second Effect' }),
        functionCall(1, 'call_q2', 'create_task', { title: 'Q2 task' }),
      ],
      'v1_q2',
      'requires_action',
    );
    const sse3 = sse(
      [
        'event: step.start\ndata: {"index":0,"step":{"type":"model_output"},"event_type":"step.start"}\n\n',
        'event: step.delta\ndata: {"index":0,"delta":{"type":"text","text":"Both tasks handled."},"event_type":"step.delta"}\n\n',
        'event: step.stop\ndata: {"index":0,"event_type":"step.stop"}\n\n',
      ],
      'v1_q3',
      'completed',
    );

    const requests: Array<Record<string, unknown>> = [];
    const strictFetch = async (_url: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push(body);
      const blocks = (body['input'] as Array<Record<string, unknown>>) ?? [];
      const users = blocks.filter((block) => block['type'] === 'user_input');
      const results = blocks.filter((block) => block['type'] === 'function_result');
      const bad400 = () => new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT' } }), { status: 400 });
      const ok = (payload: string) => new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      const noReplay = () => !blocks.some((block) => block['type'] === 'function_call' || block['type'] === 'model_output');
      const continuationOk = (prev: string, callIds: string[], answer: string) =>
        body['previous_interaction_id'] === prev &&
        users.length === 1 &&
        JSON.stringify(users[0]).includes(answer) &&
        results.length === callIds.length &&
        results.every((result, index) => result['call_id'] === callIds[index]);
      if (requests.length === 1) {
        // Initial stateless request: history and model_output blocks are legal.
        if (body['previous_interaction_id'] !== undefined) return bad400();
        return ok(sse1);
      }
      if (requests.length === 2) {
        if (!noReplay() || !continuationOk('v1_q1', ['call_q1'], '2026-10-20')) return bad400();
        return ok(sse2);
      }
      if (requests.length === 3) {
        if (!noReplay() || !continuationOk('v1_q2', ['call_effect', 'call_q2'], '2026-11-05')) return bad400();
        // The earlier answer A must not be resent as input on the later
        // continuation (the system instruction may legitimately mention it).
        if (JSON.stringify(blocks).includes('2026-10-20')) return bad400();
        return ok(sse3);
      }
      return bad400();
    };

    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'qa-answer-identity-1',
      text: 'Plan the Q1 task',
    });
    const adapter = new GeminiInteractionsAdapter({ fetchFn: strictFetch, apiKey: 'test-gemini-key' });
    const parkedQ1 = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, {
      handler: new AgentHandler({ providerAdapter: adapter, maxRoundsPerSlice: 3, limits: defaultTestLimits }),
    });
    expect(parkedQ1.status).toBe('waiting_for_input');
    const q1 = await env.DB
      .prepare(`SELECT id FROM pending_clarifications WHERE run_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`)
      .bind(accepted.run_id)
      .first<{ id: string }>();

    // Answer A resolves Q1; the same turn then proposes a committed effect
    // and parks on Q2.
    const answerA = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'qa-answer-A',
      text: '2026-10-20',
    });
    const aSource = await env.DB
      .prepare(`SELECT source_message_id FROM agent_runs WHERE id = ?`)
      .bind(answerA.run_id)
      .first<{ source_message_id: string }>();
    expect(
      (
        await resumeRun(env.DB, {
          workspaceId: ws,
          runId: accepted.run_id,
          answer: { text: '2026-10-20', messageId: aSource!.source_message_id, clarificationId: q1!.id },
        })
      ).resumed,
    ).toBe(true);
    const parkedQ2 = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, {
      handler: new AgentHandler({ providerAdapter: adapter, maxRoundsPerSlice: 3, limits: defaultTestLimits }),
    });
    expect(parkedQ2.status).toBe('waiting_for_input');
    const q2 = await env.DB
      .prepare(`SELECT id FROM pending_clarifications WHERE run_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`)
      .bind(accepted.run_id)
      .first<{ id: string }>();
    expect(q2?.id).toBeTruthy();
    expect(q2?.id).not.toBe(q1?.id);

    // Answer B on a fresh handler (restart) must send B once and never A again.
    const answerB = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'qa-answer-B',
      text: '2026-11-05',
    });
    const bSource = await env.DB
      .prepare(`SELECT source_message_id FROM agent_runs WHERE id = ?`)
      .bind(answerB.run_id)
      .first<{ source_message_id: string }>();
    expect(
      (
        await resumeRun(env.DB, {
          workspaceId: ws,
          runId: accepted.run_id,
          answer: { text: '2026-11-05', messageId: bSource!.source_message_id, clarificationId: q2!.id },
        })
      ).resumed,
    ).toBe(true);
    const finished = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, {
      handler: new AgentHandler({ providerAdapter: adapter, maxRoundsPerSlice: 3, limits: defaultTestLimits }),
    });
    expect(finished.status).toBe('completed');
    expect(requests).toHaveLength(3);
    expect((await loadRunById(accepted.run_id)).status).toBe('succeeded');

    // Exactly-once effects: one entity and one task per intended action.
    expect(
      Number(
        (await env.DB
          .prepare(`SELECT COUNT(*) AS n FROM entities WHERE workspace_id = ? AND name = 'Second Effect'`)
          .bind(ws)
          .first<{ n: number }>())?.n,
      ),
    ).toBe(1);
    const q1Task = await env.DB
      .prepare(`SELECT due_local_date FROM tasks WHERE workspace_id = ? AND title = 'Q1 task'`)
      .bind(ws)
      .first<{ due_local_date: string | null }>();
    expect(q1Task?.due_local_date).toBe('2026-10-20');
    const q2Task = await env.DB
      .prepare(`SELECT due_local_date FROM tasks WHERE workspace_id = ? AND title = 'Q2 task'`)
      .bind(ws)
      .first<{ due_local_date: string | null }>();
    expect(q2Task?.due_local_date).toBe('2026-11-05');
    expect(
      Number(
        (await env.DB
          .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ? AND title IN ('Q1 task', 'Q2 task')`)
          .bind(ws)
          .first<{ n: number }>())?.n,
      ),
    ).toBe(2);
    const duplicateReceipts = await env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT action_id FROM action_receipts WHERE workspace_id = ? AND run_id = ? GROUP BY action_id HAVING COUNT(*) > 1
         )`,
      )
      .bind(ws, accepted.run_id)
      .first<{ n: number }>();
    expect(Number(duplicateReceipts?.n)).toBe(0);
  });

  it('rejects truncated/malformed provider stream with zero tools executed', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'msg-client-trunc-1',
      text: 'Create lead Broken Entity',
    });

    // Truncated stream: yields tool_call_start and then ends abruptly without finish
    const truncatedAdapter = {
      provider: 'gemini' as const,
      audioSupport: () => ({ support: 'unverified' as const, detail: '' }),
      async *streamTurn() {
        yield { type: 'tool_call_start' as const, callId: 'call_broken', name: 'upsert_entity' };
      },
    };

    const handler = new AgentHandler({ providerAdapter: truncatedAdapter, limits: defaultTestLimits });
    const result = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });
    expect(result.status).toBe('failed');

    const run = await loadRunById(accepted.run_id);
    expect(run.status).toBe('failed');

    // Verify NO entity named 'Broken Entity' exists in D1
    const ent = await env.DB.prepare(
      `SELECT id FROM entities WHERE workspace_id = ? AND name = 'Broken Entity'`
    ).bind(ws).first();
    expect(ent).toBeNull();
  });

  it('rejects unknown tool in a call group before earlier mutations start', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'msg-client-badgroup-1',
      text: 'Do two things',
    });

    const fakeAdapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [
        {
          kind: 'tool_calls',
          calls: [
            { callId: 'call_1', name: 'upsert_entity', args: { name: 'Doomed Entity' } },
            { callId: 'call_2', name: 'unrecognized_tool_xyz', args: {} },
          ],
        },
      ],
    });

    const handler = new AgentHandler({ providerAdapter: fakeAdapter, limits: defaultTestLimits });
    const result = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });
    expect(result.status).toBe('failed');

    const run = await loadRunById(accepted.run_id);
    expect(run.status).toBe('failed');

    // Verify Doomed Entity was NEVER inserted
    const ent = await env.DB.prepare(
      `SELECT id FROM entities WHERE workspace_id = ? AND name = 'Doomed Entity'`
    ).bind(ws).first();
    expect(ent).toBeNull();
  });

  it('handles duplicate dispatch idempotently: one logical effect and one reply', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'msg-client-dup-1',
      text: 'Create entity Single Bistro',
    });

    const fakeAdapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [
        {
          kind: 'tool_calls',
          calls: [{ callId: 'call_single_bistro', name: 'upsert_entity', args: { name: 'Single Bistro' } }],
        },
        {
          kind: 'text',
          text: 'Created Single Bistro.',
        },
      ],
    });

    const handler = new AgentHandler({ providerAdapter: fakeAdapter, maxRoundsPerSlice: 3, limits: defaultTestLimits });

    // 1. First dispatch
    const res1 = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });
    expect(res1.status).toBe('completed');

    // 2. Duplicate dispatch of the same outbox item
    const res2 = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });
    expect(res2.status).toBe('already_done');

    // Verify exactly one entity was created
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM entities WHERE workspace_id = ? AND name = 'Single Bistro'`
    ).bind(ws).first<{ n: number }>();
    expect(countRow?.n).toBe(1);

    // Verify exactly one system reply was posted
    const replyCount = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`
    ).bind(accepted.run_id).first<{ n: number }>();
    expect(replyCount?.n).toBe(1);
  });

  it('recovers after crash when tool committed before step result was saved', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'msg-client-crash-1',
      text: 'Create lead Resilient Cafe',
    });

    let crashed = false;

    const fakeAdapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [
        {
          kind: 'tool_calls',
          calls: [{ callId: 'call_resilient', name: 'upsert_entity', args: { name: 'Resilient Cafe' } }],
        },
        {
          kind: 'text',
          text: 'Successfully created Resilient Cafe.',
        },
      ],
    });

    // Test hook: throws immediately AFTER the tool executes in D1, simulating a process crash
    const handlerWithCrash = new AgentHandler({
      providerAdapter: fakeAdapter,
      limits: defaultTestLimits,
      testHooks: {
        afterToolExecution: async () => {
          if (!crashed) {
            crashed = true;
            throw new Error('SIMULATED_PROCESS_CRASH_AFTER_LEDGER_COMMIT');
          }
        },
      },
    });

    // 1. First attempt: crashes after ledger commit
    const res1 = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler: handlerWithCrash });
    expect(res1.status).toBe('deferred'); // Requeued for retry

    // Verify entity was committed in D1
    const entBefore = await env.DB.prepare(
      `SELECT id FROM entities WHERE workspace_id = ? AND name = 'Resilient Cafe'`
    ).bind(ws).first<{ id: string }>();
    expect(entBefore).not.toBeNull();

    // 2. Second attempt (retry): recovers, sees the action receipt, does NOT duplicate entity
    const normalHandler = new AgentHandler({ providerAdapter: fakeAdapter, maxRoundsPerSlice: 3, limits: defaultTestLimits });
    const res2 = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler: normalHandler });
    expect(res2.status).toBe('completed');

    // Verify exactly one entity exists (no duplicate)
    const count = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM entities WHERE workspace_id = ? AND name = 'Resilient Cafe'`
    ).bind(ws).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('releases slot on clarification and allows teammate turn to complete while waiting', async () => {
    // 1. Avi requests task with missing deadline -> needs clarification
    const aviAccepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'msg-avi-clar-1',
      text: 'Create a task to call client',
    });

    const aviFakeAdapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [
        {
          kind: 'tool_calls',
          calls: [
            {
              callId: 'call_create_task_missing_due',
              name: 'create_task',
              args: { title: 'Call client about proposal' }, // Missing due
            },
          ],
        },
      ],
    });

    const aviHandler = new AgentHandler({ providerAdapter: aviFakeAdapter, limits: defaultTestLimits });
    const aviDispatch = await dispatchOutboxItem(env.DB, await outboxIdForRun(aviAccepted.run_id), ws, { handler: aviHandler });

    expect(aviDispatch.status).toBe('waiting_for_input');
    const aviRun = await loadRunById(aviAccepted.run_id);
    expect(aviRun.status).toBe('waiting_for_input');

    // 2. Slot is released! Hunor can execute his turn to completion immediately
    const hunorAccepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatHunor,
      userId: hunorId,
      clientMessageId: 'msg-hunor-turn-1',
      text: 'What is the date today?',
    });

    const hunorFakeAdapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [{ kind: 'text', text: 'Today is 2026-10-02.' }],
    });
    const hunorHandler = new AgentHandler({ providerAdapter: hunorFakeAdapter, limits: defaultTestLimits });
    const hunorDispatch = await dispatchOutboxItem(env.DB, await outboxIdForRun(hunorAccepted.run_id), ws, { handler: hunorHandler });

    expect(hunorDispatch.status).toBe('completed');
    const hunorRun = await loadRunById(hunorAccepted.run_id);
    expect(hunorRun.status).toBe('succeeded');

    // 3. Avi answers the clarification: "No deadline needed"
    await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'msg-avi-answer-1',
      text: 'No deadline for this task, make it explicit_no_deadline.',
    });

    const clar = await env.DB.prepare(
      `SELECT id FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`,
    )
      .bind(aviAccepted.run_id)
      .first<{ id: string }>();

    const min = await env.DB.prepare(
      `SELECT id FROM messages_in WHERE external_id = ?`,
    )
      .bind('msg-avi-answer-1')
      .first<{ id: string }>();

    // Resume Avi's run
    const resumeRes = await resumeRun(env.DB, {
      workspaceId: ws,
      runId: aviAccepted.run_id,
      answer: {
        text: 'No deadline needed.',
        authorUserId: aviId,
        messageId: min!.id,
        clarificationId: clar!.id,
      },
    });
    expect(resumeRes.resumed).toBe(true);

    // Avi's resumed turn executes with the answer and completes
    const aviResumeAdapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [
        {
          kind: 'tool_calls',
          calls: [
            {
              callId: 'call_create_task_resolved',
              name: 'create_task',
              args: { title: 'Call client about proposal', due: null, explicit_no_deadline: true },
            },
          ],
        },
        {
          kind: 'text',
          text: 'Task created without deadline.',
        },
      ],
    });

    const aviResumeHandler = new AgentHandler({ providerAdapter: aviResumeAdapter, maxRoundsPerSlice: 3, limits: defaultTestLimits });
    const aviFinalDispatch = await dispatchOutboxItem(
      env.DB,
      await outboxIdForRun(aviAccepted.run_id),
      ws,
      { handler: aviResumeHandler },
    );
    expect(aviFinalDispatch.status).toBe('completed');

    const aviFinalRun = await loadRunById(aviAccepted.run_id);
    expect(aviFinalRun.status).toBe('succeeded');

    // Task exists with explicit null due
    const task = await env.DB.prepare(
      `SELECT title, due_kind, status FROM tasks WHERE workspace_id = ? AND title = 'Call client about proposal'`
    ).bind(ws).first<{ title: string; due_kind: string | null; status: string }>();
    expect(task?.title).toBe('Call client about proposal');
    expect(task?.status).toBe('open');
  });

  it('keeps pinned model snapshot when default_model changes mid-run', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'msg-client-model-pin-1',
      text: 'Hello test',
    });

    // Pinned model snapshot already saved on run creation
    const snapshot = {
      commandKey: 'pinned-v1',
      provider: 'gemini',
      modelId: 'gemini-3.1-flash-lite',
      endpointFamily: 'gemini-interactions',
      promptVersion: '2026-10-02-v1',
      schemaVersion: 1,
      pinnedAt: nowIso,
    };

    await env.DB.prepare(
      `UPDATE agent_runs SET model_snapshot_json = ?, model_key = 'pinned-v1' WHERE id = ?`
    ).bind(JSON.stringify(snapshot), accepted.run_id).run();

    // Now change workspace settings default_model to something else
    await env.DB.prepare(
      `INSERT INTO workspace_settings (workspace_id, default_model, created_at, updated_at)
       VALUES (?, 'mimo-26-pro', ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET default_model = 'mimo-26-pro'`
    ).bind(ws, nowIso, nowIso).run();

    // Execute run turn
    const fakeAdapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [{ kind: 'text', text: 'Answer using pinned model.' }],
    });

    const handler = new AgentHandler({ providerAdapter: fakeAdapter, limits: defaultTestLimits });
    await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });

    // Verify run snapshot still pinned to 'pinned-v1'
    const runAfter = await env.DB.prepare(
      `SELECT model_key, model_snapshot_json FROM agent_runs WHERE id = ?`
    ).bind(accepted.run_id).first<{ model_key: string; model_snapshot_json: string }>();

    expect(runAfter?.model_key).toBe('pinned-v1');
    const parsed = JSON.parse(runAfter!.model_snapshot_json);
    expect(parsed.commandKey).toBe('pinned-v1');
  });

  it('marks run partial and reports committed work when error occurs after first action', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'msg-client-partial-1',
      text: 'Create entity and then fail',
    });

    const fakeAdapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [
        {
          kind: 'tool_calls',
          calls: [{ callId: 'call_committed_ent', name: 'upsert_entity', args: { name: 'Committed Cafe' } }],
        },
        // Round 2 fails
        { kind: 'fail', code: 'transient', message: 'Upstream rate limit exceeded.' },
      ],
    });

    const handler = new AgentHandler({ providerAdapter: fakeAdapter, maxRoundsPerSlice: 3, limits: defaultTestLimits });
    // Outbox item max attempts 1 so it terminates as partial on failure
    const result = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler, maxAttempts: 1 });

    expect(result.status).toBe('failed');
    const run = await loadRunById(accepted.run_id);
    expect(run.status).toBe('partial');

    // Verify committed entity exists in D1
    const ent = await env.DB.prepare(
      `SELECT name FROM entities WHERE workspace_id = ? AND name = 'Committed Cafe'`
    ).bind(ws).first<{ name: string }>();
    expect(ent?.name).toBe('Committed Cafe');
  });

  it('checkpoint and continuation does not collide with tool step index (F02 regression)', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'pos-checkpoint-msg',
      text: 'Create Violet Harbor',
    });
    const adapter = new FakeProviderAdapter({
      scripts: [
        { kind: 'tool_calls', calls: [{ callId: 'cp1', name: 'upsert_entity', args: { name: 'Violet Harbor' } }] },
        { kind: 'text', text: 'Done creating Violet Harbor.' },
      ],
    });
    const handler = new AgentHandler({ providerAdapter: adapter, maxRoundsPerSlice: 1, limits: defaultTestLimits });
    // First slice executes tool call and checkpoints without collision
    const res1 = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });
    expect(res1.status).toBe('deferred');

    // Run steps exist without conflict: step 0 (initial request), step 1 (planned/executed tool), step 2 (continuation checkpoint)
    const steps = (await env.DB.prepare('SELECT step_index, tool_name FROM run_steps WHERE run_id = ? ORDER BY step_index').bind(accepted.run_id).all()).results;
    expect(steps.map((s) => s['step_index'])).toEqual([0, 1, 2]);

    // Second slice finishes with text
    const res2 = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });
    expect(res2.status).toBe('completed');
  });

  it('provider follow-up retains exact tool names, arguments, and pendingToolResults (F04 regression)', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'pos-protocol-msg',
      text: 'Create Indigo Landing',
    });
    const fake = new FakeProviderAdapter({
      scripts: [
        { kind: 'tool_calls', calls: [{ callId: 'orig_call_1', name: 'upsert_entity', args: { name: 'Indigo Landing' } }] },
        { kind: 'text', text: 'Done with Indigo Landing' },
      ],
    });
    const captured: TurnInput[] = [];
    const adapter: ProviderAdapter = {
      provider: fake.provider,
      audioSupport: () => fake.audioSupport(),
      async *streamTurn(input: TurnInput) {
        captured.push(input);
        yield* fake.streamTurn(input);
      },
    };
    const res = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, {
      handler: new AgentHandler({ providerAdapter: adapter, limits: defaultTestLimits }),
    });
    expect(res.status).toBe('completed');
    expect(captured.length).toBe(2);

    // In round 2, the assistant message has the exact tool call name and arguments
    const assistantMsg = captured[1]?.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    if (assistantMsg && 'toolCalls' in assistantMsg && assistantMsg.toolCalls) {
      const call = assistantMsg.toolCalls[0]!;
      expect(call.name).toBe('upsert_entity');
      expect(JSON.parse(call.arguments)).toEqual({ name: 'Indigo Landing' });
    }

    // Pending tool results contains the tool output
    expect(captured[1]?.pendingToolResults?.length).toBe(1);
    expect(captured[1]?.pendingToolResults?.[0]?.callId).toBe('orig_call_1');
  });

  it('includes prior conversation history in subsequent turn context (F05 regression)', async () => {
    const first = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'pos-history-first',
      text: 'The temporary reference is KERNING-482.',
    });
    await dispatchOutboxItem(env.DB, await outboxIdForRun(first.run_id), ws, {
      handler: new AgentHandler({ providerAdapter: new FakeProviderAdapter({ scripts: [{ kind: 'text', text: 'Got the reference.' }] }), limits: defaultTestLimits }),
    });

    const next = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'pos-history-next',
      text: 'What was the temporary reference?',
    });

    let inputSeen: TurnInput | undefined;
    const adapter: ProviderAdapter = {
      provider: 'gemini',
      audioSupport: () => ({ support: 'unverified', detail: '' }),
      async *streamTurn(input: TurnInput) {
        inputSeen = input;
        yield { type: 'text_delta', text: 'Reference found: KERNING-482' };
        yield { type: 'finish', reason: 'success', continuation: null };
      },
    };

    await dispatchOutboxItem(env.DB, await outboxIdForRun(next.run_id), ws, {
      handler: new AgentHandler({ providerAdapter: adapter, limits: defaultTestLimits }),
    });

    // The prior conversation history is preserved in input messages
    expect(JSON.stringify(inputSeen?.messages)).toContain('KERNING-482');
  });

  it('requires confirmation for bulk operations exceeding 3 targets, resumes and executes on approval without re-asking (F08 regression)', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'pos-bulk-msg',
      text: 'Record these four businesses',
    });
    const names = ['Alpine Forge', 'Birch Studio', 'Cobalt Works', 'Dawn Harbor'];
    const fake = new FakeProviderAdapter({
      scripts: [
        { kind: 'tool_calls', calls: names.map((name, i) => ({ callId: `bulk${i}`, name: 'upsert_entity', args: { name } })) },
        { kind: 'text', text: 'All saved' },
      ],
    });
    const res = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, {
      handler: new AgentHandler({ providerAdapter: fake, limits: defaultTestLimits }),
    });

    // 1. Bulk operation > 3 targets pauses for confirmation
    expect(res.status).toBe('waiting_for_input');

    // Zero unconfirmed bulk entity writes are committed
    const appliedBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM action_receipts WHERE run_id = ? AND result_status = 'applied'").bind(accepted.run_id).first<{ n: number }>();
    expect(appliedBefore?.n).toBe(0);

    // Pending clarification is created with versioned bulk_operation payload
    const clar = await env.DB.prepare("SELECT id, status, operation_payload_json FROM pending_clarifications WHERE run_id = ? AND status = 'pending'").bind(accepted.run_id).first<{ id: string; status: string; operation_payload_json: string }>();
    expect(clar).not.toBeNull();
    expect(clar?.operation_payload_json).toContain('bulk_operation');

    // 2. Member provides explicit approval message
    const ansMsg = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'ans-bulk-confirm',
      text: 'Yes, proceed with all of them',
    });
    const ansRunRow = await env.DB.prepare('SELECT source_message_id FROM agent_runs WHERE id = ?').bind(ansMsg.run_id).first<{ source_message_id: string }>();

    // 3. resumeRun routes to standard resumption, unblocks the run and resolves clarification
    const resumeRes = await resumeRun(env.DB, {
      workspaceId: ws,
      runId: accepted.run_id,
      answer: { text: 'Yes, proceed', messageId: ansRunRow!.source_message_id, clarificationId: clar!.id },
    });
    expect(resumeRes.resumed).toBe(true);

    // 4. Duplicate answer is rejected
    const dupRes = await resumeRun(env.DB, {
      workspaceId: ws,
      runId: accepted.run_id,
      answer: { text: 'Yes again', messageId: ansRunRow!.source_message_id, clarificationId: clar!.id },
    });
    expect(dupRes.resumed).toBe(false);

    // 5. Resumed run executes exact four entities once without re-asking (survives handler restart)
    const freshHandler = new AgentHandler({ providerAdapter: fake, limits: defaultTestLimits });
    const resumeOutboxId = await outboxIdForRun(accepted.run_id);
    const resumeDispatch = await dispatchOutboxItem(env.DB, resumeOutboxId, ws, {
      handler: freshHandler,
    });
    expect(resumeDispatch.status).toBe('completed');

    // Exactly 4 entity applied receipts exist
    const appliedAfter = await env.DB.prepare("SELECT COUNT(*) AS n FROM action_receipts WHERE run_id = ? AND result_status = 'applied'").bind(accepted.run_id).first<{ n: number }>();
    expect(appliedAfter?.n).toBe(4);

    // All 4 entities are committed in D1
    for (const name of names) {
      const ent = await env.DB.prepare('SELECT id FROM entities WHERE workspace_id = ? AND name = ?').bind(ws, name).first();
      expect(ent).not.toBeNull();
    }
  });

  it('bulk operation rejection cancels execution without any entity commits', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'pos-bulk-reject-msg',
      text: 'Record these four other businesses',
    });
    const names = ['Echo Ridge', 'Fox Hollow', 'Glen Park', 'Highland Mills'];
    const fake = new FakeProviderAdapter({
      scripts: [
        { kind: 'tool_calls', calls: names.map((name, i) => ({ callId: `bulk_rej_${i}`, name: 'upsert_entity', args: { name } })) },
        { kind: 'text', text: 'All saved' },
      ],
    });
    const res = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, {
      handler: new AgentHandler({ providerAdapter: fake, limits: defaultTestLimits }),
    });
    expect(res.status).toBe('waiting_for_input');

    const clar = await env.DB.prepare("SELECT id FROM pending_clarifications WHERE run_id = ? AND status = 'pending'").bind(accepted.run_id).first<{ id: string }>();

    // Member rejects
    const ansMsg = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'ans-bulk-reject',
      text: 'No, do not proceed, cancel it',
    });
    const ansRunRow = await env.DB.prepare('SELECT source_message_id FROM agent_runs WHERE id = ?').bind(ansMsg.run_id).first<{ source_message_id: string }>();

    const resumeRes = await resumeRun(env.DB, {
      workspaceId: ws,
      runId: accepted.run_id,
      answer: { text: 'No, cancel', messageId: ansRunRow!.source_message_id, clarificationId: clar!.id },
    });
    expect(resumeRes.resumed).toBe(true);

    const resumeOutboxId = await outboxIdForRun(accepted.run_id);
    const resumeDispatch = await dispatchOutboxItem(env.DB, resumeOutboxId, ws, {
      handler: new AgentHandler({ providerAdapter: fake, limits: defaultTestLimits }),
    });
    expect(resumeDispatch.status).toBe('completed');

    // Zero entities committed
    const applied = await env.DB.prepare("SELECT COUNT(*) AS n FROM action_receipts WHERE run_id = ? AND result_status = 'applied'").bind(accepted.run_id).first<{ n: number }>();
    expect(applied?.n).toBe(0);

    for (const name of names) {
      const ent = await env.DB.prepare('SELECT id FROM entities WHERE workspace_id = ? AND name = ?').bind(ws, name).first();
      expect(ent).toBeNull();
    }
  });

  it('rejects cancelled provider stream without executing proposed tools (F04 regression)', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'pos-cancelled-msg',
      text: 'Create Copper Hollow',
    });
    const adapter: ProviderAdapter = {
      provider: 'gemini',
      audioSupport: () => ({ support: 'unverified', detail: '' }),
      async *streamTurn() {
        yield { type: 'tool_call_start', callId: 'can1', name: 'upsert_entity' };
        yield { type: 'tool_call_arguments', callId: 'can1', argumentsChunk: JSON.stringify({ name: 'Copper Hollow' }) };
        yield { type: 'tool_call_end', callId: 'can1', name: 'upsert_entity', args: { name: 'Copper Hollow' } };
        yield { type: 'finish', reason: 'cancelled', continuation: null };
      },
    };
    const res = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, {
      handler: new AgentHandler({ providerAdapter: adapter, maxRoundsPerSlice: 1, limits: defaultTestLimits }),
    });
    expect(res.status).toBe('failed');
    expect(res.detail).toBe('provider_stream_error');

    const entity = await env.DB.prepare('SELECT id FROM entities WHERE workspace_id = ? AND name = ?').bind(ws, 'Copper Hollow').first();
    expect(entity).toBeNull();
  });

  it('real provider branch resolves model matching saved model pin (F03 regression)', async () => {
    const { setWorkspaceCredential } = await import('@otis/identity');
    const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    await setWorkspaceCredential(env.DB, {
      workspaceId: ws,
      provider: 'opencode_go',
      rawKey: 'synthetic-review-credential',
      wrappingKey,
      keyVersion: 1,
      actorUserId: aviId,
    });
    await env.DB.prepare("UPDATE provider_credentials SET status = 'available' WHERE workspace_id = ? AND provider = 'opencode_go'").bind(ws).run();

    // Default model in workspace settings is set to mimo-26-pro
    await env.DB.prepare("INSERT INTO workspace_settings(workspace_id, default_model, created_at, updated_at) VALUES (?, 'mimo-26-pro', ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET default_model = 'mimo-26-pro'").bind(ws, nowIso, nowIso).run();

    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'pos-real-pin',
      text: 'Hello test',
    });

    // Pinned to mimo-25
    const pinned = {
      commandKey: 'mimo-25',
      provider: 'opencode_go',
      modelId: 'mimo-v2.5',
      endpointFamily: 'go-chat-completions',
      promptVersion: '2026-10-02-v1',
      schemaVersion: 1,
      pinnedAt: nowIso,
    };
    await env.DB.prepare("UPDATE agent_runs SET model_snapshot_json = ?, model_key = 'mimo-25' WHERE id = ?").bind(JSON.stringify(pinned), accepted.run_id).run();

    let bodySeen: Record<string, unknown> | undefined;
    const handler = new AgentHandler({
      wrappingKey,
      limits: defaultTestLimits,
      fetchFn: async (_url, init) => {
        bodySeen = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ error: { message: 'synthetic transport rejection' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });
    // Outgoing request body has model 'mimo-v2.5', NOT the changed workspace default 'mimo-v2.6-pro'!
    expect(bodySeen?.['model']).toBe('mimo-v2.5');
  });

  it('clarification resume executes saved command once and does not duplicate on subsequent round (F06 regression)', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'pos-task-first',
      text: 'Create a task to call Riverstone',
    });
    const first = new FakeProviderAdapter({
      scripts: [{ kind: 'tool_calls', calls: [{ callId: 'qtask', name: 'create_task', args: { title: 'Call Riverstone' } }] }],
    });
    const waiting = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, {
      handler: new AgentHandler({ providerAdapter: first, limits: defaultTestLimits }),
    });
    expect(waiting.status).toBe('waiting_for_input');

    const clar = await env.DB.prepare("SELECT id FROM pending_clarifications WHERE run_id = ? AND status = 'pending'").bind(accepted.run_id).first<{ id: string }>();
    const answer = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'pos-task-answer',
      text: 'No deadline needed.',
    });
    const answerSource = await env.DB.prepare('SELECT source_message_id FROM agent_runs WHERE id = ?').bind(answer.run_id).first<{ source_message_id: string }>();

    const resumed = await resumeRun(env.DB, {
      workspaceId: ws,
      runId: accepted.run_id,
      answer: {
        text: 'No deadline needed.',
        messageId: answerSource!.source_message_id,
        authorUserId: aviId,
        clarificationId: clar!.id,
        resolvedFields: { due: null },
      },
    });
    expect(resumed.resumed).toBe(true);

    // Initial task is committed
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ? AND title = ?').bind(ws, 'Call Riverstone').first<{ n: number }>();
    expect(before?.n).toBe(1);

    // Follow-up round completes with text
    const next = new FakeProviderAdapter({
      scripts: [{ kind: 'text', text: 'Task Call Riverstone is saved without deadline.' }],
    });
    const res = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, {
      handler: new AgentHandler({ providerAdapter: next, limits: defaultTestLimits }),
    });
    expect(res.status).toBe('completed');

    // Exactly 1 task exists, not duplicated!
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ? AND title = ?').bind(ws, 'Call Riverstone').first<{ n: number }>();
    expect(after?.n).toBe(1);
  });

  it('redispatching completed phase returns final answer immediately without spinning (F01 regression)', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'pos-completed-phase',
      text: 'Hello test',
    });

    await env.DB.prepare("UPDATE agent_runs SET agent_progress_json = ? WHERE id = ?")
      .bind(JSON.stringify({ phase: 'completed', roundNumber: 1, finalAnswer: 'Recovered final answer' }), accepted.run_id)
      .run();

    // Redispatch loads completed phase and returns final answer immediately without calling provider or spinning
    const retryAdapter = new FakeProviderAdapter({ scripts: [] });
    const retryHandler = new AgentHandler({ providerAdapter: retryAdapter, limits: defaultTestLimits });
    const res = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler: retryHandler });
    expect(res.status).toBe('completed');

    const run = await loadRunById(accepted.run_id);
    expect(run.status).toBe('succeeded');
  });

  it('enforces atomic daily action limits in workspace_daily_actions and rejects mutations once limit reached (F07 regression)', async () => {
    await env.DB.prepare('DELETE FROM workspace_daily_actions WHERE workspace_id = ?').bind(ws).run();

    const accepted1 = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'pos-daily-action-1',
      text: 'Create Entity One',
    });
    const fake1 = new FakeProviderAdapter({
      scripts: [
        { kind: 'tool_calls', calls: [{ callId: 'c1', name: 'upsert_entity', args: { name: 'Entity One' } }] },
        { kind: 'text', text: 'Entity One created' },
      ],
    });
    const handler = new AgentHandler({
      providerAdapter: fake1,
      limits: { maxDailyActions: 1, maxRoundsPerRun: 5 },
    });
    const res1 = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted1.run_id), ws, { handler });
    expect(res1.status).toBe('completed');

    // Verify workspace_daily_actions has 1 action recorded
    const todayUtc = nowIso.slice(0, 10);
    const counter = await env.DB.prepare('SELECT action_count FROM workspace_daily_actions WHERE workspace_id = ? AND date_utc = ?')
      .bind(ws, todayUtc)
      .first<{ action_count: number }>();
    expect(counter?.action_count).toBe(1);

    // Second action exceeds limit of 1
    const accepted2 = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'pos-daily-action-2',
      text: 'Create Entity Two',
    });
    const fake2 = new FakeProviderAdapter({
      scripts: [
        { kind: 'tool_calls', calls: [{ callId: 'c2', name: 'upsert_entity', args: { name: 'Entity Two' } }] },
        { kind: 'text', text: 'Entity Two created' },
      ],
    });
    const handler2 = new AgentHandler({
      providerAdapter: fake2,
      limits: { maxDailyActions: 1, maxRoundsPerRun: 5 },
    });
    const res2 = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted2.run_id), ws, { handler: handler2 });
    expect(res2.status).toBe('failed');
    expect(res2.detail).toBe('daily_action_limit_exceeded');

    // Entity Two was not created
    const entity2 = await env.DB.prepare('SELECT id FROM entities WHERE workspace_id = ? AND name = ?').bind(ws, 'Entity Two').first();
    expect(entity2).toBeNull();
  });

  it('refuses run execution when required limits are missing or non-positive (F07 regression)', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'pos-no-limits',
      text: 'Hello test',
    });
    const fake = new FakeProviderAdapter({ scripts: [{ kind: 'text', text: 'hi' }] });
    // Intentionally no limits configured
    const handler = new AgentHandler({ providerAdapter: fake });
    const res = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });
    expect(res.status).toBe('failed');
    expect(res.detail).toBe('missing_budgets');
  });

  it('terminates run when maxRoundsPerRun is exceeded (F07 regression)', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'pos-max-rounds',
      text: 'Create Entity Max Round',
    });
    const fake = new FakeProviderAdapter({
      scripts: [
        { kind: 'tool_calls', calls: [{ callId: 'c_mr', name: 'upsert_entity', args: { name: 'Entity Max Round' } }] },
        { kind: 'text', text: 'Finished round 2' },
      ],
    });
    // Set maxRoundsPerRun to 1, but this flow requires round 1 (tool) + round 2 (text)
    const handler = new AgentHandler({
      providerAdapter: fake,
      limits: { maxDailyActions: 50, maxRoundsPerRun: 1 },
      maxRoundsPerSlice: 1,
    });
    // Round 1 executes tool call and defers
    const res1 = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });
    expect(res1.status).toBe('deferred');

    // Round 2 is attempted but roundNumber 2 > maxRoundsPerRun 1
    const res2 = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });
    expect(res2.status).toBe('failed');
    expect(res2.detail).toBe('max_rounds_exceeded');
  });
  it('steers an in-flight provider response before its proposed writes, with one durable run and no extra outbox', async () => {
    const accepted = await acceptWebMessage(env.DB, { workspaceId: ws, chatId: chatAvi, userId: aviId, clientMessageId: 'steer-stream-original', text: 'Create the old business' });
    const fake = new FakeProviderAdapter({ provider: 'gemini', scripts: [
      { kind: 'tool_calls', calls: [{ callId: 'stale', name: 'upsert_entity', args: { name: 'Steering stale business' } }] },
      { kind: 'tool_calls', calls: [{ callId: 'correct', name: 'upsert_entity', args: { name: 'Steering correct business' } }] },
      { kind: 'text', text: 'Saved the corrected business.' },
    ] });
    const inputs: TurnInput[] = []; let inputCount = 0; let steering: Awaited<ReturnType<typeof acceptWebMessage>> | undefined;
    const adapter: ProviderAdapter = { provider: 'gemini', audioSupport: () => fake.audioSupport(), async *streamTurn(input) {
      inputs.push(input); if (inputCount++ === 0) steering = await acceptWebMessage(env.DB, { workspaceId: ws, chatId: chatAvi, userId: aviId, clientMessageId: 'steer-stream-context', text: 'Actually use the correct business instead.', steerRunId: accepted.run_id });
      yield* fake.streamTurn(input);
    } };
    const result = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler: new AgentHandler({ providerAdapter: adapter, maxRoundsPerSlice: 4, limits: defaultTestLimits }) });
    expect(result.status).toBe('completed'); expect(steering?.run_id).toBe(accepted.run_id); expect(steering?.mode).toBe('steer');
    expect(inputs[1]!.messages.some(message => message.text?.includes('Actually use the correct business instead.'))).toBe(true);
    expect(await env.DB.prepare(`SELECT id FROM entities WHERE workspace_id = ? AND name = 'Steering stale business'`).bind(ws).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT id FROM entities WHERE workspace_id = ? AND name = 'Steering correct business'`).bind(ws).first()).not.toBeNull();
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE json_extract(payload_json, '$.run_id') = ?`).bind(accepted.run_id).first<{ n: number }>(); expect(count?.n).toBe(1);
    const retry = await acceptWebMessage(env.DB, { workspaceId: ws, chatId: chatAvi, userId: aviId, clientMessageId: 'steer-stream-context', text: 'Actually use the correct business instead.' });
    expect(retry).toEqual(steering);
  });

  it('preserves an already committed action, supersedes later proposals, and attributes the steered write to the new input', async () => {
    const accepted = await acceptWebMessage(env.DB, { workspaceId: ws, chatId: chatAvi, userId: aviId, clientMessageId: 'steer-between-original', text: 'Create two businesses' });
    const fake = new FakeProviderAdapter({ provider: 'gemini', scripts: [
      { kind: 'tool_calls', calls: [{ callId: 'saved', name: 'upsert_entity', args: { name: 'Quartz Apothecary' } }, { callId: 'discarded', name: 'upsert_entity', args: { name: 'Nebula Atelier' } }] },
      { kind: 'tool_calls', calls: [{ callId: 'adjusted', name: 'upsert_entity', args: { name: 'Maple Fermentation' } }] },
      { kind: 'text', text: 'Kept the first change and saved the corrected second business.' },
    ] });
    let injected = false;
    const handler = new AgentHandler({ providerAdapter: fake, maxRoundsPerSlice: 4, limits: defaultTestLimits, testHooks: { afterToolExecution: async () => { if (!injected) { injected = true; await acceptWebMessage(env.DB, { workspaceId: ws, chatId: chatAvi, userId: aviId, clientMessageId: 'steer-between-context', text: 'Keep the first business; change the second one.', steerRunId: accepted.run_id }); } } } });
    const result = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler }); expect(result.status).toBe('completed');
    const names = (await env.DB.prepare(`SELECT name FROM entities WHERE workspace_id = ? AND name IN ('Quartz Apothecary', 'Nebula Atelier', 'Maple Fermentation')`).bind(ws).all<{ name: string }>()).results.map(row => row.name);
    expect(names).toContain('Quartz Apothecary'); expect(names).toContain('Maple Fermentation'); expect(names).not.toContain('Nebula Atelier');
    const source = await env.DB.prepare(`SELECT id FROM messages_in WHERE external_id = 'steer-between-context'`).first<{ id: string }>();
    const receipt = await env.DB.prepare(`SELECT source_message_id FROM action_receipts WHERE workspace_id = ? AND action_id = ?`).bind(ws, `${accepted.run_id}_r1_t0`).first<{ source_message_id: string }>(); expect(receipt?.source_message_id).toBe(source?.id);
    const replay = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler }); expect(replay.status).toBe('already_done');
  });

  it('retains steering across bounded continuation and rejects teammate injection without creating an input', async () => {    const accepted = await acceptWebMessage(env.DB, { workspaceId: ws, chatId: chatAvi, userId: aviId, clientMessageId: 'steer-restart-original', text: 'Create a record' });
    await expect(acceptWebMessage(env.DB, { workspaceId: ws, chatId: chatAvi, userId: hunorId, clientMessageId: 'steer-forbidden', text: 'Change it', steerRunId: accepted.run_id })).rejects.toThrow('Only the chat author');
    expect(await env.DB.prepare(`SELECT id FROM messages_in WHERE external_id = 'steer-forbidden'`).first()).toBeNull();
    const fake = new FakeProviderAdapter({ provider: 'gemini', scripts: [{ kind: 'tool_calls', calls: [{ callId: 'abandoned', name: 'upsert_entity', args: { name: 'Steering restart abandoned' } }] }, { kind: 'text', text: 'No record is needed now.' }] });
    let injected = false;
    const first = new AgentHandler({ providerAdapter: fake, maxRoundsPerSlice: 1, limits: defaultTestLimits, testHooks: { beforeToolExecution: async () => { if (!injected) { injected = true; await acceptWebMessage(env.DB, { workspaceId: ws, chatId: chatAvi, userId: aviId, clientMessageId: 'steer-restart-context', text: 'Do not create anything. Just acknowledge.', steerRunId: accepted.run_id }); } } } });
    const firstResult = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler: first }); expect(firstResult.status).toBe('deferred'); expect(firstResult.detail).toBe('checkpoint');
    const secondResult = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler: new AgentHandler({ providerAdapter: fake, maxRoundsPerSlice: 3, limits: defaultTestLimits }) }); expect(secondResult.status).toBe('completed');
    const checkpoint = await env.DB.prepare('SELECT agent_progress_json FROM agent_runs WHERE id = ?').bind(accepted.run_id).first<{ agent_progress_json: string }>(); expect(checkpoint?.agent_progress_json).toContain('Do not create anything. Just acknowledge.');
    expect(await env.DB.prepare(`SELECT id FROM entities WHERE name = 'Steering restart abandoned'`).first()).toBeNull();
  });

  it('reuses one membership/credential resolution across linked provider rounds', async () => {    const entry = PRODUCTION_REGISTRY.entries.find((item) => item.commandKey === 'gemini-3.1-flash-lite')!;
    const streamBody = [
      'event: interaction.created\n',
      'data: {"interaction":{"id":"v1_reuse","status":"in_progress","model":"gemini-3.1-flash-lite"},"event_type":"interaction.created"}\n\n',
      'event: step.start\n',
      'data: {"index":0,"step":{"type":"model_output"},"event_type":"step.start"}\n\n',
      'event: step.delta\n',
      'data: {"index":0,"delta":{"type":"text","text":"Noted."},"event_type":"step.delta"}\n\n',
      'event: step.stop\n',
      'data: {"index":0,"event_type":"step.stop"}\n\n',
      'event: interaction.completed\n',
      'data: {"interaction":{"id":"v1_reuse","status":"completed","usage":{"total_tokens":8,"total_input_tokens":5,"total_output_tokens":3}},"event_type":"interaction.completed"}\n\n',
      'event: done\n',
      'data: [DONE]\n\n',
    ].join('');
    const fetchFn = (async (): Promise<Response> =>
      new Response(streamBody, { headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;
    const baseInput = {
      sessionId: chatAvi,
      workspaceId: ws,
      chatId: chatAvi,
      runId: 'run_reuse_key',
      messages: [{ role: 'user', text: 'hi' }],
      pendingToolResults: [],
      tools: [],
      maxOutputTokens: 64,
      timeoutMs: 5000,
    } as const;
    const countingDb = (counter: { n: number }): D1Database =>
      new Proxy(env.DB, {
        get(target, prop, receiver) {
          if (prop === 'prepare') {
            return (sql: string) => {
              if (/workspace_users|provider_credentials/.test(sql)) counter.n += 1;
              return (target as D1Database).prepare(sql);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(target) : value;
        },
      }) as D1Database;

    // Control: full resolution reads membership metadata.
    const control = { n: 0 };
    const key = await resolveProviderRawKey(countingDb(control), {
      workspaceId: ws,
      actorUserId: aviId,
      entry,
      platformKeys: { gemini: 'test-key' },
    });
    expect(key).toBe('test-key');
    expect(control.n).toBeGreaterThan(0);

    // Pre-resolved rounds issue zero metadata reads and still stream text.
    for (let round = 0; round < 2; round++) {
      const roundCounter = { n: 0 };
      const events = [];
      for await (const event of runProviderTurn(countingDb(roundCounter), {
        workspaceId: ws,
        actorUserId: aviId,
        entry,
        platformKeys: { gemini: 'test-key' },
        preResolvedRawKey: key,
        input: { ...baseInput, requestId: `req-reuse-${round}` },
        fetchFn,
      })) {
        events.push(event);
      }
      expect(roundCounter.n).toBe(0);
      expect(events.some((event) => event.type === 'text_delta')).toBe(true);
    }
  });

  it('maps mid-turn credential resolution failure to provider_stream_error, not the retry loop', async () => {
    const { setWorkspaceCredential } = await import('@otis/identity');
    const goodKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    await setWorkspaceCredential(env.DB, {
      workspaceId: ws,
      provider: 'gemini',
      rawKey: 'synthetic-real-credential',
      wrappingKey: goodKey,
      keyVersion: 1,
      actorUserId: aviId,
    });
    const wrongKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    await env.DB.prepare(`UPDATE provider_credentials SET status = 'available' WHERE workspace_id = ? AND provider = 'gemini'`).bind(ws).run();
    await env.DB.prepare(`INSERT INTO workspace_settings (workspace_id, default_model, created_at, updated_at) VALUES (?, 'gemini-3.1-flash-lite', ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET default_model = 'gemini-3.1-flash-lite'`).bind(ws, nowIso, nowIso).run();
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws, chatId: chatAvi, userId: aviId, clientMessageId: 'msg-bad-key', text: 'Hello with broken key',
    });
    const handler = new AgentHandler({ wrappingKey: wrongKey, limits: defaultTestLimits });
    const result = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });
    // Terminal failure with the provider error, not a deferred retry loop.
    expect(result.status).toBe('failed');
    expect(await env.DB.prepare(`SELECT status FROM agent_runs WHERE id = ?`).bind(accepted.run_id).first<{ status: string }>()).toEqual({ status: 'failed' });
    await env.DB.prepare(`DELETE FROM provider_credentials WHERE workspace_id = ? AND provider = 'gemini'`).bind(ws).run();
    await env.DB.prepare(`UPDATE workspace_settings SET default_model = NULL WHERE workspace_id = ?`).bind(ws).run();
  });

  it('keeps checkpoints linear: only the latest round retains its continuation', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'msg-client-linear-1',
      text: 'Check entities, then tasks, then report',
    });
    const bigCursor = 'x'.repeat(2000);
    const fakeAdapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [
        { kind: 'tool_calls', calls: [{ callId: 'call_lin_1', name: 'query', args: { resource: 'entities', cursor: bigCursor } }] },
        {
          kind: 'tool_result_continuation',
          intermediateText: '',
          calls: [{ callId: 'call_lin_2', name: 'query', args: { resource: 'tasks', cursor: bigCursor } }],
          finalText: '',
        },
        { kind: 'text', text: 'Checked both lists.' },
      ],
    });
    const handler = new AgentHandler({ providerAdapter: fakeAdapter, maxRoundsPerSlice: 5, limits: defaultTestLimits });
    const result = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });
    expect(result.status).toBe('completed');
    expect(fakeAdapter.calls.length).toBe(3);

    const row = await env.DB.prepare(`SELECT agent_progress_json FROM agent_runs WHERE id = ?`)
      .bind(accepted.run_id)
      .first<{ agent_progress_json: string | null }>();
    const progressJson = String(row?.agent_progress_json ?? '');
    const progress = JSON.parse(progressJson) as {
      completedRounds?: Array<{ roundIndex: number; continuation: unknown }>;
    };
    const rounds = progress.completedRounds ?? [];
    // Two tool rounds completed (the closing text round carries no calls and
    // stores no round entry); three provider turns ran in total.
    expect(rounds.length).toBeGreaterThanOrEqual(2);
    // Replay continues from the latest continuation only; older cumulative
    // copies are dropped, so stored bytes grow with rounds, not rounds².
    for (const round of rounds.slice(0, -1)) {
      expect(round.continuation).toBeNull();
    }
    expect(rounds[rounds.length - 1]!.continuation).not.toBeNull();
    expect(progressJson.length).toBeLessThan(30000);
  });

  it('automatically retries transient provider errors (503 / 429) and recovers cleanly', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId: chatAvi,
      userId: aviId,
      clientMessageId: 'msg-retry-test-1',
      text: 'Test transient retry',
    });
    let callCount = 0;
    const retryAdapter: ProviderAdapter = {
      provider: 'gemini',
      audioSupport: () => ({ support: 'unsupported', detail: 'test' }),
      async *streamTurn() {
        callCount++;
        if (callCount === 1) {
          yield {
            type: 'error',
            error: { code: 'transient', message: 'Gemini service error (503).', retryable: true, retryAfterMs: 50, status: 503 },
          };
          return;
        }
        yield { type: 'text_delta', text: 'Recovered cleanly from 503.' };
        yield { type: 'finish', reason: 'success', continuation: null };
      },
    };
    const handler = new AgentHandler({ providerAdapter: retryAdapter, maxRoundsPerSlice: 3, limits: defaultTestLimits });
    const result = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, { handler });
    expect(result.status).toBe('completed');
    expect(callCount).toBe(2);

    const savedMessage = await env.DB.prepare(
      `SELECT content_text FROM chat_messages WHERE chat_id = ? AND author_kind = 'assistant' ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(chatAvi)
      .first<{ content_text: string }>();
    expect(savedMessage?.content_text).toBe('Recovered cleanly from 503.');
  });
});


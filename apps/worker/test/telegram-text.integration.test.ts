/**
 * 009A Telegram text loop integration (real workerd + D1, synthetic
 * Telegram HTTP only). Proves the assigned journey end to end:
 *
 *   guided linking -> text capture with immediate wake -> question parking
 *   with native-reply clarification -> durable completion delivery ->
 *   later retrieval through the real AgentHandler tool loop -> commands ->
 *   delivery outcome policy.
 *
 * The fake Bot API below never contacts Telegram; the fake provider is a
 * scripted test double for the real AgentHandler, so tool orchestration and
 * ledger writes are production code. This is local evidence, not a live bot.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
import { AUTH_BOUNDS, type TelegramConnectionResponse, type TelegramLinkResponse } from '@otis/contracts';
import { sha256 } from '@otis/identity';
import { FakeProviderAdapter } from '@otis/agent';
import { executeLedgerCommand, handleCreateTask } from '@otis/ledger';
import { AgentHandler } from '../src/agent/handler.js';
import { dispatchOutboxItem, type TurnHandler } from '../src/actor/dispatch.js';
import { claimWorkspaceLease, releaseWorkspaceLease } from '../src/actor/leases.js';
import { acceptTelegramInbound } from '../src/inbox/telegram.js';
import { executeTelegramCommand } from '../src/inbox/telegramCommands.js';
import { deliverTelegramOutbox, scanTelegramDue } from '../src/inbox/telegramDelivery.js';
import { handleTelegramWebhook } from '../src/routes/inbound.js';
import worker from '../src/index.js';

const WS = 'ws-tg-009a';
const AVI = 'usr_tg_avi';
const HUNOR = 'usr_tg_hunor';
const nowIso = () => new Date().toISOString();
const TOKEN = '111111:test_synthetic_token';

let aviCookie = '';
let hunorCookie = '';
const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
/** Bot message ID of the question resolved by the parks test (obsolete-reply fixture). */
let resolvedQuestionBotMessageId = 0;

/**
 * Deterministic delivery clock: per-chat pacing is one send per second, so
 * tests advance this clock between same-chat sends instead of sleeping.
 */
let deliveryNowMs = Date.parse('2026-10-04T08:00:00.000Z');
function deliveryClock(): string {
  // Advances on every read: within one invocation the one-second per-chat
  // pacing must see real elapsed time, exactly like production.
  const iso = new Date(deliveryNowMs).toISOString();
  deliveryNowMs += 1_500;
  return iso;
}
function advanceDeliveryClock(ms = 2_000): void {
  deliveryNowMs += ms;
}
async function deliverAll(extra: { fetchFn?: typeof okFetch } = {}) {
  advanceDeliveryClock();
  return deliverTelegramOutbox(env.DB, env, {
    fetchFn: extra.fetchFn ?? okFetch,
    clock: deliveryClock,
  });
}

async function okFetch(url: string, init: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  sent.push({ url, body });
  return new Response(
    JSON.stringify({ ok: true, result: { message_id: 900 + sent.length, chat: { id: Number(body['chat_id']), type: 'private' } } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function fetchReplies(replies: Array<{ status?: number; json?: unknown; throwError?: boolean; empty?: boolean }>) {
  let index = 0;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fn = async (url: string, init: RequestInit): Promise<Response> => {
    const scripted = replies[Math.min(index, replies.length - 1)]!;
    index += 1;
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    if (scripted.throwError) throw new Error('synthetic transport failure');
    const payload = scripted.empty
      ? null
      : JSON.stringify(scripted.json ?? { ok: true, result: { message_id: 500 + index, chat: { id: 777001, type: 'private' } } });
    return new Response(payload, {
      status: scripted.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fn, calls, count: () => index };
}

function postWebhook(body: unknown): Promise<Response> {
  // Direct handler invocation with wake-up bindings removed: the suite's
  // synthetic journey must not spawn asynchronous actor dispatches whose
  // timing would make due-selection assertions nondeterministic. The route
  // still exercises the production acceptance path, token gate and hints
  // (a dedicated test below injects a fake actor and observes them).
  const request = new Request('http://localhost/api/inbound/telegram', {
    method: 'POST',
    headers: {
      'x-telegram-bot-api-secret-token': 'test_webhook_secret_999',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const quietEnv = { ...env, DISPATCH_QUEUE: undefined, WORKSPACE_ACTOR: undefined } as typeof env;
  return handleTelegramWebhook(request, quietEnv, 'req-tg-009a');
}

function textUpdate(id: number, from: number, text: string, replyTo?: number) {
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: from },
      chat: { id: from, type: 'private' },
      date: 1700000000,
      text,
      ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
    },
  };
}

async function outboxIdForRun(runId: string): Promise<string> {
  const row = await env.DB
    .prepare(`SELECT id FROM outbox WHERE json_extract(payload_json, '$.run_id') = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(runId)
    .first<{ id: string }>();
  if (!row) throw new Error(`outbox for run ${runId} missing`);
  return row.id;
}

/**
 * Test-only true-tail failure: appends a deliberately invalid statement
 * AFTER every production statement of a batch, so the real D1 batch aborts
 * at its true end and rolls everything back. Mirrors the ledger-footprint
 * pattern; no production hook.
 */
function poisonTailDb(db: D1Database): D1Database {
  const inners = new WeakMap<object, D1PreparedStatement>();
  const wrap = (inner: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'bind') {
          return (...args: unknown[]) => wrap((target.bind as (...bound: unknown[]) => D1PreparedStatement)(...args));
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function' ? (value as (...callArgs: unknown[]) => unknown).bind(target) : value;
      },
    }) as D1PreparedStatement;
    inners.set(proxy, inner);
    return proxy;
  };
  return {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (statements: D1PreparedStatement[]) => {
      const poison = db.prepare('INSERT INTO entities (id) VALUES (NULL)');
      return db.batch([...statements.map((statement) => inners.get(statement) ?? statement), poison]);
    },
  } as unknown as D1Database;
}

async function deliveryRow(runId: string, kind: string) {
  return env.DB
    .prepare(
      `SELECT id, status, payload_json, attempt_count, next_retry_at FROM outbox
       WHERE destination = 'telegram' AND json_extract(payload_json, '$.run_id') = ?
         AND json_extract(payload_json, '$.kind') = ? ORDER BY json_extract(payload_json, '$.part_index') ASC`,
    )
    .bind(runId, kind)
    .first<{ id: string; status: string; payload_json: string; attempt_count: number; next_retry_at: string | null }>();
}

async function issueLink(cookie: string): Promise<{ code: string; deepLink: string }> {
  const res = await SELF.fetch(`http://localhost/api/workspaces/${WS}/telegram/link`, {
    method: 'POST',
    headers: {
      cookie,
      origin: 'http://localhost',
      [AUTH_BOUNDS.CSRF_HEADER]: '1',
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as TelegramLinkResponse;
  const code = new URL(body.deep_link).searchParams.get('start');
  expect(code).toBeTruthy();
  return { code: code!, deepLink: body.deep_link };
}

describe('009A Telegram text loop (workerd + D1)', () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
    env.ENVIRONMENT = 'test';
    env.TELEGRAM_WEBHOOK_SECRET = 'test_webhook_secret_999';
    env.TELEGRAM_BOT_INSTALLATION_ID = 'test_bot';
    env.TELEGRAM_BOT_USERNAME = 'otis_test_bot';
    env.TELEGRAM_BOT_TOKEN = TOKEN;

    const now = nowIso();
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    for (const [id, name] of [[AVI, 'Avi'], [HUNOR, 'Hunor']] as const) {
      await env.DB.prepare(
        `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, `fb_${id}`, `${id}@kerning.test`, name, now, now)
        .run();
    }
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, last_acceptance_sequence, created_at, updated_at)
       VALUES (?, 'Kerning 009A', ?, 0, 2, 0, ?, ?)`,
    )
      .bind(WS, AVI, now, now)
      .run();
    for (const [user, role] of [[AVI, 'owner'], [HUNOR, 'member']] as const) {
      await env.DB.prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(WS, user, role, now, now, now)
        .run();
    }
    // Deterministic date interpretation for the clarification case.
    await env.DB.prepare(
      `INSERT INTO member_settings (workspace_id, user_id, brief_enabled, brief_timezone, brief_channel, preferred_language, created_at, updated_at)
       VALUES (?, ?, 0, 'Europe/Bucharest', 'telegram', 'en', ?, ?)`,
    )
      .bind(WS, HUNOR, now, now)
      .run();
    for (const [id, token] of [['sess_tg_avi', 'session_token_tg_avi'], ['sess_tg_hunor', 'session_token_tg_hunor']] as const) {
      await env.DB.prepare(
        `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      )
        .bind(id, await sha256(token), id.endsWith('avi') ? AVI : HUNOR, now, expiresAt, now)
        .run();
    }
    aviCookie = `${AUTH_BOUNDS.COOKIE_NAME}=session_token_tg_avi`;
    hunorCookie = `${AUTH_BOUNDS.COOKIE_NAME}=session_token_tg_hunor`;
  });

  // Each test starts from a drained Telegram queue: pending rows left by a
  // test (or blocked by an unknown predecessor) must not leak into another
  // test's due selection or pacing window.
  afterEach(async () => {
    for (let i = 0; i < 6; i += 1) {
      const pending = await env.DB
        .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE destination = 'telegram' AND status IN ('pending', 'sending')`)
        .first<{ n: number }>();
      if (Number(pending?.n ?? 0) === 0) break;
      advanceDeliveryClock(5_000);
      await deliverTelegramOutbox(env.DB, env, { fetchFn: okFetch, clock: deliveryClock });
    }
  });

  it('issuer mints a hash-only 32-char code with workspace intent; old codes die; redemption links once', async () => {
    const first = await issueLink(aviCookie);
    expect(first.deepLink).toMatch(/^https:\/\/t\.me\/otis_test_bot\?start=[A-Za-z0-9_-]{32}$/);

    const hashed = await env.DB
      .prepare(`SELECT id, code_hash, requested_workspace_id, consumed_at FROM link_codes WHERE code_hash = ?`)
      .bind(await sha256(first.code))
      .first<Record<string, unknown>>();
    expect(hashed).toBeTruthy();
    expect(hashed!['requested_workspace_id']).toBe(WS);
    expect(String(hashed!['code_hash'])).not.toBe(first.code);

    // Explicitly generating a replacement invalidates the prior unused code.
    const second = await issueLink(aviCookie);
    const oldRow = await env.DB
      .prepare(`SELECT consumed_at FROM link_codes WHERE code_hash = ?`)
      .bind(await sha256(first.code))
      .first<{ consumed_at: string | null }>();
    expect(oldRow?.consumed_at).not.toBeNull();

    // Old code: truthful expiry guidance, no consumption, no linking.
    const expiredRes = await postWebhook(textUpdate(7001, 777001, `/start ${first.code}`));
    expect(expiredRes.status).toBe(200);
    expect(((await expiredRes.json()) as { status: string }).status).toBe('unrouted');

    // Current code: linked with the requested workspace, one confirmation.
    const linkedRes = await postWebhook(textUpdate(7002, 777001, `/start ${second.code}`));
    expect(linkedRes.status).toBe(200);
    const linked = (await linkedRes.json()) as { status: string; user_id?: string; workspace_id?: string };
    expect(linked.status).toBe('linked');
    expect(linked.user_id).toBe(AVI);
    expect(linked.workspace_id).toBe(WS);

    const binding = await env.DB
      .prepare(`SELECT user_id, selected_workspace_id FROM telegram_users WHERE telegram_user_id = '777001'`)
      .first<Record<string, unknown>>();
    expect(binding!['user_id']).toBe(AVI);
    expect(binding!['selected_workspace_id']).toBe(WS);

    const confirmations = await env.DB
      .prepare(`SELECT payload_json FROM outbox WHERE destination = 'telegram' AND json_extract(payload_json, '$.kind') = 'admin'`)
      .all<{ payload_json: string }>();
    const confirmationTexts = (confirmations.results ?? []).map(
      (row) => (JSON.parse(row.payload_json) as { text: string }).text,
    );
    expect(confirmationTexts.some((text) => text.includes('Connected to Avi in Kerning 009A'))).toBe(true);
    // The expired-code guidance is workspace-less: persisted, never an
    // outbox row (outbox requires a workspace FK).
    const expiredSource = await env.DB
      .prepare(`SELECT status, error_message FROM messages_in WHERE external_id = 'test_bot:7001'`)
      .first<{ status: string; error_message: string | null }>();
    expect(expiredSource?.status).toBe('unrouted');
    expect(expiredSource?.error_message).toBe('Invalid or expired link code');

    // Redelivery of the same update: same result, one source row, one delivery, no run.
    const replayRes = await postWebhook(textUpdate(7002, 777001, `/start ${second.code}`));
    const replay = (await replayRes.json()) as { status: string };
    expect(replay.status).toBe('linked');
    const sourceRows = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM messages_in WHERE channel = 'telegram' AND external_id = 'test_bot:7002'`)
      .first<{ n: number }>();
    expect(Number(sourceRows?.n)).toBe(1);
    const runs = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE source_message_id IN (SELECT id FROM messages_in WHERE external_id = 'test_bot:7002')`)
      .first<{ n: number }>();
    expect(Number(runs?.n)).toBe(0);

    // The workspace-scoped confirmation goes out through the delivery
    // engine; the delivered row records the Bot message ID, and no
    // parse_mode is ever sent.
    const summary = await deliverAll();
    expect(summary.delivered).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body['chat_id']).toBe('777001');
    expect('parse_mode' in sent[0]!.body).toBe(false);
    expect(sent[0]!.url).toContain('/sendMessage');
    const confirmationDelivered = await env.DB
      .prepare(
        `SELECT payload_json, status FROM outbox WHERE destination = 'telegram'
           AND json_extract(payload_json, '$.kind') = 'admin'
           AND payload_json LIKE '%Connected to Avi%'`,
      )
      .first<{ payload_json: string; status: string }>();
    expect(confirmationDelivered?.status).toBe('delivered');
    expect((JSON.parse(confirmationDelivered!.payload_json) as { telegram_message_id: number }).telegram_message_id).toBeGreaterThan(0);
  });

  it('sends a workspace-less admin reply best-effort once through the injected transport', async () => {
    const fakeCalls: Array<{ body: Record<string, unknown> }> = [];
    const fakeTransport = async (_url: string, init: RequestInit): Promise<Response> => {
      fakeCalls.push({ body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 990, chat: { id: 777001, type: 'private' } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const update = textUpdate(7050, 777001, '/start definitely_expired_code_000');
    const first = await acceptTelegramInbound(env.DB, 'test_bot', update, {
      botToken: TOKEN,
      adminTransport: fakeTransport,
    });
    expect(first.status).toBe('unrouted');
    expect(fakeCalls).toHaveLength(1);
    expect(String(fakeCalls[0]!.body['text'])).toContain('That link expired');
    expect(String(fakeCalls[0]!.body['chat_id'])).toBe('777001');

    // Duplicate delivery: the persisted row makes the dedupe branch return
    // early, so nothing is sent twice.
    const replay = await acceptTelegramInbound(env.DB, 'test_bot', update, {
      botToken: TOKEN,
      adminTransport: fakeTransport,
    });
    expect(replay.status).toBe('unrouted');
    expect(fakeCalls).toHaveLength(1);
    const rows = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM messages_in WHERE external_id = 'test_bot:7050'`)
      .first<{ n: number }>();
    expect(Number(rows?.n)).toBe(1);
  });

  it('committing redemption guard rejects conflicting bindings and revoked intent without replacement', async () => {
    // Exact production guard SQL against a post-precheck conflicting binding:
    // it must yield NULL (batch-aborting), and the conditional upsert must
    // never replace the existing owner.
    const telegramId = '777099';
    const now = nowIso();
    await env.DB
      .prepare(
        `INSERT INTO telegram_users (telegram_user_id, user_id, selected_workspace_id, active_chat_id, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      )
      .bind(telegramId, AVI, WS, now, now)
      .run();
    const guardSql = `SELECT (SELECT 1
      WHERE NOT EXISTS (SELECT 1 FROM telegram_users WHERE telegram_user_id = ? AND user_id <> ?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?))) AS ok`;
    const conflictGuard = await env.DB.prepare(guardSql).bind(telegramId, HUNOR, WS, WS, HUNOR).first<{ ok: number | null }>();
    expect(conflictGuard?.ok).toBeNull();

    await env.DB
      .prepare(
        `INSERT INTO telegram_users (telegram_user_id, user_id, selected_workspace_id, active_chat_id, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?)
         ON CONFLICT(telegram_user_id) DO UPDATE SET
           user_id = excluded.user_id,
           selected_workspace_id = excluded.selected_workspace_id,
           active_chat_id = NULL,
           updated_at = excluded.updated_at
         WHERE telegram_users.user_id = excluded.user_id`,
      )
      .bind(telegramId, HUNOR, WS, now, now)
      .run();
    const owner = await env.DB
      .prepare(`SELECT user_id FROM telegram_users WHERE telegram_user_id = ?`)
      .bind(telegramId)
      .first<{ user_id: string }>();
    expect(owner?.user_id).toBe(AVI);

    // Revoked requested intent: the guard fails for a workspace the user is
    // not (or no longer) a member of.
    const revokedGuard = await env.DB
      .prepare(guardSql)
      .bind('777098', HUNOR, 'ws-revoked-intent', 'ws-revoked-intent', HUNOR)
      .first<{ ok: number | null }>();
    expect(revokedGuard?.ok).toBeNull();

    // End-to-end revoked intent: the code is refused unconsumed and no
    // binding is created.
    const code = 'revoked_intent_code_0001';
    await env.DB
      .prepare(
        `INSERT INTO link_codes (id, code_hash, user_id, requested_workspace_id, created_at, expires_at, consumed_at)
         VALUES ('lc_revoked_intent', ?, ?, 'ws-revoked-intent', ?, ?, NULL)`,
      )
      .bind(await sha256(code), HUNOR, now, new Date(Date.now() + 600_000).toISOString())
      .run();
    const res = await postWebhook(textUpdate(7060, 777098, `/start ${code}`));
    expect(((await res.json()) as { status: string }).status).toBe('unrouted');
    const codeRow = await env.DB
      .prepare(`SELECT consumed_at FROM link_codes WHERE id = 'lc_revoked_intent'`)
      .first<{ consumed_at: string | null }>();
    expect(codeRow?.consumed_at).toBeNull();
    expect(
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM telegram_users WHERE telegram_user_id = '777098'`).first<{ n: number }>())?.n,
    ).toBe(0);

    await env.DB.prepare(`DELETE FROM telegram_users WHERE telegram_user_id = ?`).bind(telegramId).run();
  });

  it('status DTO is read-only and truthfully reports connected routing', async () => {
    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM link_codes`).first<{ n: number }>();
    const res = await SELF.fetch(`http://localhost/api/workspaces/${WS}/telegram/connection`, {
      headers: { cookie: hunorCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TelegramConnectionResponse;
    expect(body.state).toBe('disconnected');
    expect(body.routing_workspace).toBeNull();
    // Hunor sees only his own status; Avi's connection is not disclosed.
    expect(body.connections).toEqual([]);
    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM link_codes`).first<{ n: number }>();
    expect(Number(after?.n)).toBe(Number(before?.n));

    const aviRes = await SELF.fetch(`http://localhost/api/workspaces/${WS}/telegram/connection`, {
      headers: { cookie: aviCookie },
    });
    const aviBody = (await aviRes.json()) as TelegramConnectionResponse;
    expect(aviBody.state).toBe('connected');
    expect(aviBody.routing_workspace).toEqual({ id: WS, name: 'Kerning 009A' });
  });

  it('links Hunor, captures text with immediate wake hints, and replays without new work', async () => {
    // Direct binding insert for the second member; linking was exercised above.
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO telegram_users (telegram_user_id, user_id, selected_workspace_id, active_chat_id, created_at, updated_at)
       VALUES ('777002', ?, ?, NULL, ?, ?)`,
    )
      .bind(HUNOR, WS, now, now)
      .run();

    // Route-level hint observation with a fake actor binding and fake ctx.
    // Interactive Telegram acceptance wakes the workspace actor directly;
    // the Queue is not on the latency path (its sends stay empty here).
    const queueMessages: unknown[] = [];
    const actorCalls: unknown[] = [];
    const fakeEnv = {
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
      DISPATCH_QUEUE: { send: async (message: unknown) => void queueMessages.push(message) },
    } as typeof env;
    const waitUntils: Array<Promise<unknown>> = [];
    const fakeCtx = {
      waitUntil: (promise: Promise<unknown>) => void waitUntils.push(promise),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const request = new Request('http://localhost/api/inbound/telegram', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'test_webhook_secret_999',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(textUpdate(7101, 777002, 'Remind the team that Bistro Paprika prefers Tuesday deliveries.')),
    });
    const res = await handleTelegramWebhook(request, fakeEnv, 'req-009a-7101', fakeCtx);
    expect(res.status).toBe(200);
    const accepted = (await res.json()) as { status: string; run_id: string; workspace_id: string };
    expect(accepted.status).toBe('accepted');
    expect(accepted.workspace_id).toBe(WS);
    await Promise.all(waitUntils);
    expect(actorCalls).toContainEqual(expect.objectContaining({ action: 'dispatch', workspace_id: WS }));
    expect(queueMessages).toEqual([]);

    // Duplicate delivery of the same update: stable run ID, no second run.
    const replayRes = await postWebhook(textUpdate(7101, 777002, 'Remind the team that Bistro Paprika prefers Tuesday deliveries.'));
    const replay = (await replayRes.json()) as { status: string; run_id?: string };
    expect(replay.status).toBe('accepted');
    expect(replay.run_id).toBe(accepted.run_id);
    const runCount = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE source_message_id IN (SELECT id FROM messages_in WHERE external_id = 'test_bot:7101')`)
      .first<{ n: number }>();
    expect(Number(runCount?.n)).toBe(1);
  });

  it('drives the real AgentHandler with a scripted provider: fact saved by ledger, delivered over fake Telegram', async () => {
    const runRow = await env.DB
      .prepare(`SELECT id FROM agent_runs WHERE source_message_id IN (SELECT id FROM messages_in WHERE external_id = 'test_bot:7101')`)
      .first<{ id: string }>();
    const runId = String(runRow!.id);

    const adapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [
        {
          kind: 'tool_calls',
          calls: [
            {
              callId: 'call_save_bistro',
              name: 'remember_context',
              args: {
                scope: 'workspace',
                category: 'other_context',
                content: 'Bistro Paprika prefers Tuesday deliveries.',
              },
            },
          ],
        },
        { kind: 'text', text: 'Saved: Bistro Paprika prefers Tuesday deliveries.' },
      ],
    });
    const handler = new AgentHandler({ providerAdapter: adapter, limits: { maxDailyActions: 50, maxRoundsPerRun: 10 } });
    const dispatched = await dispatchOutboxItem(env.DB, await outboxIdForRun(runId), WS, { handler });
    expect(dispatched.status).toBe('completed');

    // Real ledger write recorded the fact.
    const memory = await env.DB
      .prepare(`SELECT payload_json FROM events WHERE workspace_id = ? AND kind = 'memory_note' ORDER BY sequence DESC LIMIT 1`)
      .bind(WS)
      .first<{ payload_json: string }>();
    expect(memory?.payload_json).toContain('Bistro Paprika prefers Tuesday deliveries.');

    // Completion committed the durable delivery next to the reply bubble.
    const delivery = await deliveryRow(runId, 'final');
    expect(delivery).toBeTruthy();
    expect(delivery!.status).toBe('pending');
    const payload = JSON.parse(delivery!.payload_json) as { text: string; source_message_id: string };
    expect(payload.text).toBe('Saved: Bistro Paprika prefers Tuesday deliveries.');

    // Commit followed by a lost hint / restarted delivery still sends.
    const sentBefore = sent.length;
    const firstDelivery = await deliverAll();
    expect(firstDelivery.delivered).toBe(1);
    const sentBody = sent[sent.length - 1]!.body;
    expect(sentBody['text']).toBe('Saved: Bistro Paprika prefers Tuesday deliveries.');
    expect(String(sentBody['chat_id'])).toBe('777002');
    const recorded = await deliveryRow(runId, 'final');
    expect(recorded!.status).toBe('delivered');
    const recordedPayload = JSON.parse(recorded!.payload_json) as { telegram_message_id: number };
    expect(recordedPayload.telegram_message_id).toBeGreaterThan(0);

    // A second delivery invocation finds nothing new (no duplicate sends).
    await deliverAll();
    expect(sent.length).toBe(sentBefore + 1);
  });

  it('retrieves the stored fact through the real tool loop on a later text', async () => {
    const res = await postWebhook(textUpdate(7102, 777002, 'What does Bistro Paprika prefer?'));
    const accepted = (await res.json()) as { status: string; run_id: string };
    expect(accepted.status).toBe('accepted');

    const adapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [
        { kind: 'tool_calls', calls: [{ callId: 'call_search_bistro', name: 'search_memory', args: { query: 'Bistro Paprika' } }] },
        { kind: 'text', text: 'Bistro Paprika prefers Tuesday deliveries.' },
      ],
    });
    const handler = new AgentHandler({ providerAdapter: adapter, limits: { maxDailyActions: 50, maxRoundsPerRun: 10 } });
    const dispatched = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), WS, { handler });
    expect(dispatched.status).toBe('completed');

    // The tool result came from D1 (the saved fact), not from the fake model.
    const step = await env.DB
      .prepare(`SELECT result_json FROM run_steps WHERE run_id = ? AND tool_name = 'search_memory' ORDER BY step_index DESC LIMIT 1`)
      .bind(accepted.run_id)
      .first<{ result_json: string }>();
    expect(step?.result_json).toContain('Tuesday');
    const finalDelivery = await deliveryRow(accepted.run_id, 'final');
    expect(finalDelivery).toBeTruthy();
    await deliverAll();
    expect(sent[sent.length - 1]!.body['text']).toBe('Bistro Paprika prefers Tuesday deliveries.');
  });

  it('parks a question, delivers it, resumes the exact pending task from a native reply once', async () => {
    const askHandler: TurnHandler = {
      name: 'telegram-ask',
      async runTurn(ctx) {
        if (ctx.answerText) return { kind: 'completed', replyText: `Scheduled for ${ctx.answerText}.` };
        return {
          kind: 'needs_input',
          question: 'Which day should the delivery be?',
          intendedOperation: 'create_task',
          missingFields: ['due'],
        };
      },
    };
    const res = await postWebhook(textUpdate(7201, 777002, 'Schedule the Paprika delivery.'));
    const accepted = (await res.json()) as { status: string; run_id: string };
    const dispatched = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), WS, { handler: askHandler });
    expect(dispatched.status).toBe('waiting_for_input');

    const question = await deliveryRow(accepted.run_id, 'question');
    expect(question).toBeTruthy();
    const questionPayload = JSON.parse(question!.payload_json) as {
      text: string;
      clarification_id: string;
      telegram_chat_id: string;
    };
    expect(questionPayload.text).toBe('Which day should the delivery be?');
    expect(questionPayload.clarification_id).toBeTruthy();

    // Deliver the question; the recorded Bot message ID is the reply target.
    const questionSend = await deliverAll();
    expect(questionSend.delivered).toBe(1);
    const deliveredQuestion = await deliveryRow(accepted.run_id, 'question');
    const deliveredPayload = JSON.parse(deliveredQuestion!.payload_json) as { telegram_message_id: number };
    const botMessageId = deliveredPayload.telegram_message_id;
    resolvedQuestionBotMessageId = botMessageId;

    // Native reply resumes the exact clarification; the answer is attributed
    // and stored in the same author chat with the waiting run ID.
    const replyRes = await postWebhook(textUpdate(7202, 777002, 'Tuesday', botMessageId));
    const reply = (await replyRes.json()) as { status: string; run_id?: string };
    expect(reply.status).toBe('accepted');
    expect(reply.run_id).toBe(accepted.run_id);

    const clarRow = await env.DB
      .prepare(`SELECT status, answer_message_id FROM pending_clarifications WHERE id = ?`)
      .bind(questionPayload.clarification_id)
      .first<{ status: string; answer_message_id: string | null }>();
    expect(clarRow?.status).toBe('resolved');

    const answerBubble = await env.DB
      .prepare(`SELECT content_text, run_id FROM chat_messages WHERE inbound_message_id = ?`)
      .bind(String(clarRow!.answer_message_id))
      .first<{ content_text: string; run_id: string }>();
    expect(answerBubble?.content_text).toBe('Tuesday');
    expect(answerBubble?.run_id).toBe(accepted.run_id);

    // Redelivery of the same answer replays without resolving anything twice.
    const replayRes = await postWebhook(textUpdate(7202, 777002, 'Tuesday', botMessageId));
    expect(((await replayRes.json()) as { status: string }).status).toBe('accepted');
    const resolvedCount = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM pending_clarifications WHERE run_id = ? AND status = 'resolved'`)
      .bind(accepted.run_id)
      .first<{ n: number }>();
    expect(Number(resolvedCount?.n)).toBe(1);
  });

  it('explains an obsolete native reply instead of silently rerouting it', async () => {
    // Replying to the already-resolved question: the mapping still exists,
    // but the clarification is not pending, so the text is kept as an
    // ordinary note with an explanation.
    const res = await postWebhook(textUpdate(7301, 777002, 'This answers nothing', resolvedQuestionBotMessageId));
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('accepted');
    const explanation = await env.DB
      .prepare(`SELECT payload_json FROM outbox WHERE destination = 'telegram' AND json_extract(payload_json, '$.key') = ?`)
      .bind('obsolete:test_bot:7301')
      .first<{ payload_json: string }>();
    expect(explanation).toBeTruthy();
    const text = (JSON.parse(explanation!.payload_json) as { text: string }).text;
    expect(text).toContain('can\u2019t answer that question here');
    await deliverAll();
  });

  it('rejects resume of an unreadable ledger date, keeps the question, and asks again', async () => {
    const ledgerAsk: TurnHandler = {
      name: 'telegram-ledger-date',
      async runTurn(ctx) {
        if (ctx.answerText) return { kind: 'completed', replyText: `Booked with note ${ctx.answerText}.` };
        const wsRow = await env.DB
          .prepare(`SELECT business_revision, membership_revision FROM workspaces WHERE id = ?`)
          .bind(WS)
          .first<{ business_revision: number; membership_revision: number }>();
        const res = await executeLedgerCommand(
          env.DB,
          {
            workspace_id: WS,
            action_id: `act_${ctx.runId}_review`,
            actor: { kind: 'member', user_id: HUNOR },
            membership_revision: Number(wsRow?.membership_revision ?? 0),
            expected_business_revision: Number(wsRow?.business_revision ?? 0),
            source_message_id: ctx.sourceMessageId!,
            run_id: ctx.runId,
            chat_id: ctx.chatId,
            request_id: `req_${ctx.runId}_${ctx.attemptId}`,
            fence: ctx.fence,
          },
          'create_task',
          { task_id: `tsk_${ctx.runId}`, title: 'Annual review' },
          handleCreateTask,
          undefined,
          { deferRunTransition: true },
        );
        if (res.status === 'needs_clarification') {
          return {
            kind: 'needs_input',
            question: res.clarification?.prompt ?? 'What date should the review be?',
            intendedOperation: 'create_task',
            missingFields: res.clarification?.missing_fields ?? ['due'],
          };
        }
        return { kind: 'failed', errorCode: 'ledger', errorMessage: res.error?.message ?? 'ledger failed' };
      },
    };

    const res = await postWebhook(textUpdate(7401, 777002, 'Book the annual review.'));
    const accepted = (await res.json()) as { status: string; run_id: string };
    await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), WS, { handler: ledgerAsk });
    await deliverAll();
    const botMessageId = (JSON.parse((await deliveryRow(accepted.run_id, 'question'))!.payload_json) as { telegram_message_id: number }).telegram_message_id;

    // A date the ledger cannot parse: the pending question and answer source stay.
    const unusable = await postWebhook(textUpdate(7402, 777002, 'whenever', botMessageId));
    expect(((await unusable.json()) as { status: string }).status).toBe('accepted');
    const stillPending = await env.DB
      .prepare(`SELECT status FROM pending_clarifications WHERE run_id = ?`)
      .bind(accepted.run_id)
      .first<{ status: string }>();
    expect(stillPending?.status).toBe('pending');
    const retryPrompt = await env.DB
      .prepare(`SELECT payload_json FROM outbox WHERE destination = 'telegram' AND json_extract(payload_json, '$.key') = ?`)
      .bind('answer-detail:test_bot:7402')
      .first<{ payload_json: string }>();
    expect(retryPrompt).toBeTruthy();
    expect((JSON.parse(retryPrompt!.payload_json) as { text: string }).text).toContain('missing detail');

    // A usable date resumes the same pending task.
    const usable = await postWebhook(textUpdate(7403, 777002, '2026-10-15', botMessageId));
    expect(((await usable.json()) as { status: string }).status).toBe('accepted');
    const resolved = await env.DB
      .prepare(`SELECT status FROM pending_clarifications WHERE run_id = ?`)
      .bind(accepted.run_id)
      .first<{ status: string }>();
    expect(resolved?.status).toBe('resolved');
  });

  it('composes Telegram /undo with real provenance, true-tail rollback and replay safety', async () => {
    // A real ledger change through the real AgentHandler tool loop.
    const changeRes = await postWebhook(textUpdate(7801, 777002, 'Create the Undo Probe entity for the revert test.'));
    const change = (await changeRes.json()) as { run_id: string };
    const changeAdapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [
        { kind: 'tool_calls', calls: [{ callId: 'call_undo_probe', name: 'upsert_entity', args: { name: 'Undo Probe' } }] },
        { kind: 'text', text: 'Created Undo Probe.' },
      ],
    });
    await dispatchOutboxItem(env.DB, await outboxIdForRun(change.run_id), WS, {
      handler: new AgentHandler({ providerAdapter: changeAdapter, limits: { maxDailyActions: 50, maxRoundsPerRun: 10 } }),
    });
    expect(
      (await env.DB.prepare(`SELECT id FROM entities WHERE workspace_id = ? AND name = 'Undo Probe'`).bind(WS).first()),
    ).toBeTruthy();

    // /undo composes the ledger revert with the Telegram source, command run,
    // reply bubble, activity and delivery in one batch.
    const undoRes = await postWebhook(textUpdate(7802, 777002, '/undo'));
    expect(((await undoRes.json()) as { status: string }).status).toBe('accepted');
    const undoSource = await env.DB
      .prepare(`SELECT id, status FROM messages_in WHERE external_id = 'test_bot:7802'`)
      .first<{ id: string; status: string }>();
    expect(undoSource?.status).toBe('processed');
    const undoActionId = `undo_${WS}_tg:test_bot:7802`;
    const revertEvent = await env.DB
      .prepare(`SELECT action_id, source_message_id FROM events WHERE workspace_id = ? AND kind = 'revert' ORDER BY sequence DESC LIMIT 1`)
      .bind(WS)
      .first<{ action_id: string; source_message_id: string | null }>();
    expect(revertEvent?.action_id).toBe(undoActionId);
    expect(revertEvent?.source_message_id).toBe(undoSource!.id);
    expect(
      (await env.DB.prepare(`SELECT result_status FROM action_receipts WHERE workspace_id = ? AND action_id = ?`).bind(WS, undoActionId).first<{ result_status: string }>())?.result_status,
    ).toBe('applied');
    expect(
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM entities WHERE workspace_id = ? AND name = 'Undo Probe'`).bind(WS).first<{ n: number }>())?.n,
    ).toBe(0);
    const undoDelivery = await env.DB
      .prepare(
        `SELECT payload_json FROM outbox WHERE destination = 'telegram'
           AND json_extract(payload_json, '$.kind') = 'command'
           AND json_extract(payload_json, '$.source_message_id') = ?`,
      )
      .bind(undoSource!.id)
      .first<{ payload_json: string }>();
    expect(undoDelivery).toBeTruthy();
    expect((JSON.parse(undoDelivery!.payload_json) as { text: string }).text.length).toBeGreaterThan(0);
    expect(
      (await env.DB
        .prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`)
        .bind(`run_cmd_${WS}_tg:test_bot:7802`)
        .first<{ n: number }>())?.n,
    ).toBe(1);

    // Redelivery of the same /undo changes no event, revision or delivery.
    const revisionBefore = (await env.DB.prepare(`SELECT business_revision FROM workspaces WHERE id = ?`).bind(WS).first<{ business_revision: number }>())!.business_revision;
    const revertsBefore = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND kind = 'revert'`).bind(WS).first<{ n: number }>())!.n;
    const deliveriesBefore = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE destination = 'telegram'`).first<{ n: number }>())!.n;
    const replayRes = await postWebhook(textUpdate(7802, 777002, '/undo'));
    expect(((await replayRes.json()) as { status: string }).status).toBe('accepted');
    expect((await env.DB.prepare(`SELECT business_revision FROM workspaces WHERE id = ?`).bind(WS).first<{ business_revision: number }>())?.business_revision).toBe(revisionBefore);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND kind = 'revert'`).bind(WS).first<{ n: number }>())?.n).toBe(revertsBefore);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE destination = 'telegram'`).first<{ n: number }>())?.n).toBe(deliveriesBefore);

    // True-tail failure: a second real change, then a poisoned batch must
    // roll back the business undo, source receipt, command run, reply and
    // delivery together.
    const change2Res = await postWebhook(textUpdate(7803, 777002, 'Create the Undo Tail Probe entity.'));
    const change2 = (await change2Res.json()) as { run_id: string };
    const change2Adapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [
        { kind: 'tool_calls', calls: [{ callId: 'call_undo_tail', name: 'upsert_entity', args: { name: 'Undo Tail Probe' } }] },
        { kind: 'text', text: 'Created Undo Tail Probe.' },
      ],
    });
    await dispatchOutboxItem(env.DB, await outboxIdForRun(change2.run_id), WS, {
      handler: new AgentHandler({ providerAdapter: change2Adapter, limits: { maxDailyActions: 50, maxRoundsPerRun: 10 } }),
    });
    expect(
      (await env.DB.prepare(`SELECT id FROM entities WHERE workspace_id = ? AND name = 'Undo Tail Probe'`).bind(WS).first()),
    ).toBeTruthy();

    const activeChat = await env.DB
      .prepare(`SELECT id FROM chats WHERE workspace_id = ? AND author_user_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(WS, HUNOR)
      .first<{ id: string }>();
    const tailExternalId = 'test_bot:7901';
    const tailSourceId = `min_${crypto.randomUUID()}`;
    const tailPayload = JSON.stringify(textUpdate(7901, 777002, '/undo'));
    const revisionBeforeTail = (await env.DB.prepare(`SELECT business_revision FROM workspaces WHERE id = ?`).bind(WS).first<{ business_revision: number }>())!.business_revision;
    const revertsBeforeTail = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND kind = 'revert'`).bind(WS).first<{ n: number }>())!.n;
    await expect(
      executeTelegramCommand(poisonTailDb(env.DB), {
        workspaceId: WS,
        userId: HUNOR,
        telegramUserId: '777002',
        telegramChatId: '777002',
        botInstallationId: 'test_bot',
        chatId: activeChat!.id,
        sourceMessageId: tailSourceId,
        externalId: tailExternalId,
        fingerprint: await sha256(tailPayload),
        persistedPayload: tailPayload,
        clientOperationId: 'tg:test_bot:7901',
        text: '/undo',
        nowIso: nowIso(),
        requestId: 'req-undo-tail',
      }),
    ).rejects.toThrow();
    expect(
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages_in WHERE external_id = ?`).bind(tailExternalId).first<{ n: number }>())?.n,
    ).toBe(0);
    expect(
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND action_id = ?`).bind(WS, `undo_${WS}_tg:test_bot:7901`).first<{ n: number }>())?.n,
    ).toBe(0);
    expect(
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE destination = 'telegram' AND json_extract(payload_json, '$.source_message_id') = ?`).bind(tailSourceId).first<{ n: number }>())?.n,
    ).toBe(0);
    expect(
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE run_id = ?`).bind(`run_cmd_${WS}_tg:test_bot:7901`).first<{ n: number }>())?.n,
    ).toBe(0);
    expect((await env.DB.prepare(`SELECT business_revision FROM workspaces WHERE id = ?`).bind(WS).first<{ business_revision: number }>())?.business_revision).toBe(revisionBeforeTail);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND kind = 'revert'`).bind(WS).first<{ n: number }>())?.n).toBe(revertsBeforeTail);
    // No partial undo: the tail-probe entity remains.
    expect(
      (await env.DB.prepare(`SELECT id FROM entities WHERE workspace_id = ? AND name = 'Undo Tail Probe'`).bind(WS).first()),
    ).toBeTruthy();
  });

  it('runs deterministic commands without the model and without web bubbles', async () => {
    const res = await postWebhook(textUpdate(7501, 777002, '/model default'));
    expect(((await res.json()) as { status: string }).status).toBe('accepted');

    const commandRow = await env.DB
      .prepare(`SELECT id, status FROM messages_in WHERE external_id = 'test_bot:7501'`)
      .first<{ id: string; status: string }>();
    expect(commandRow?.status).toBe('processed');
    const commandDelivery = await env.DB
      .prepare(`SELECT payload_json FROM outbox WHERE destination = 'telegram' AND json_extract(payload_json, '$.kind') = 'command'`)
      .first<{ payload_json: string }>();
    expect(commandDelivery).toBeTruthy();
    expect((JSON.parse(commandDelivery!.payload_json) as { text: string }).text.length).toBeGreaterThan(0);

    const modelRuns = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE executor_kind = 'agent' AND source_message_id = ?`)
      .bind(commandRow!.id)
      .first<{ n: number }>();
    expect(Number(modelRuns?.n)).toBe(0);

    // Unknown commands answer deterministically instead of reaching the model.
    const unknown = await postWebhook(textUpdate(7502, 777002, '/frobnicate'));
    expect(((await unknown.json()) as { status: string }).status).toBe('accepted');
    const unknownRuns = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE executor_kind = 'agent' AND source_message_id IN (SELECT id FROM messages_in WHERE external_id = 'test_bot:7502')`)
      .first<{ n: number }>();
    expect(Number(unknownRuns?.n)).toBe(0);

    // /thinking high persists the scoped override with a deterministic reply.
    // Uses a model with verified thinking controls (MiMo controls are
    // unverified by design and stay rejected).
    const now = nowIso();
    await env.DB
      .prepare(
        `INSERT INTO workspace_settings (workspace_id, default_model, created_at, updated_at)
         VALUES (?, 'gemini-3.1-flash-lite', ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET default_model = excluded.default_model, updated_at = excluded.updated_at`,
      )
      .bind(WS, now, now)
      .run();
    const thinking = await postWebhook(textUpdate(7503, 777002, '/thinking high'));
    expect(((await thinking.json()) as { status: string }).status).toBe('accepted');
    const thinkingChat = await env.DB
      .prepare(`SELECT thinking_override_json FROM chats WHERE id = (SELECT chat_id FROM messages_in WHERE external_id = 'test_bot:7503')`)
      .first<{ thinking_override_json: string | null }>();
    expect(thinkingChat?.thinking_override_json).toContain('"choice_id":"high"');
    expect(thinkingChat?.thinking_override_json).toContain('"model_key":"gemini-3.1-flash-lite"');
    expect(
      (await env.DB
        .prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE executor_kind = 'agent' AND source_message_id IN (SELECT id FROM messages_in WHERE external_id = 'test_bot:7503')`)
        .first<{ n: number }>())?.n,
    ).toBe(0);

    // /today answers from the member's seeded timezone and open tasks.
    const today = await postWebhook(textUpdate(7504, 777002, '/today'));
    expect(((await today.json()) as { status: string }).status).toBe('accepted');
    const todayText = await env.DB
      .prepare(
        `SELECT payload_json FROM outbox WHERE destination = 'telegram' AND json_extract(payload_json, '$.kind') = 'command'
           AND json_extract(payload_json, '$.source_message_id') = (SELECT id FROM messages_in WHERE external_id = 'test_bot:7504')`,
      )
      .first<{ payload_json: string }>();
    expect((JSON.parse(todayText!.payload_json) as { text: string }).text).toBe('You have no due work right now.');

    // /workspace switches only this Telegram identity's selection and back.
    await env.DB
      .prepare(
        `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, last_acceptance_sequence, created_at, updated_at)
         VALUES ('ws-studio-009a', 'Studio', ?, 0, 1, 0, ?, ?)`,
      )
      .bind(AVI, now, now)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
         VALUES ('ws-studio-009a', ?, 'member', ?, ?, ?)`,
      )
      .bind(HUNOR, now, now, now)
      .run();
    const switchRes = await postWebhook(textUpdate(7505, 777002, '/workspace Studio'));
    expect(((await switchRes.json()) as { status: string }).status).toBe('accepted');
    const switched = await env.DB
      .prepare(`SELECT selected_workspace_id FROM telegram_users WHERE telegram_user_id = '777002'`)
      .first<{ selected_workspace_id: string | null }>();
    expect(switched?.selected_workspace_id).toBe('ws-studio-009a');
    const switchBack = await postWebhook(textUpdate(7506, 777002, '/workspace Kerning 009A'));
    expect(((await switchBack.json()) as { status: string }).status).toBe('accepted');
    const back = await env.DB
      .prepare(`SELECT selected_workspace_id FROM telegram_users WHERE telegram_user_id = '777002'`)
      .first<{ selected_workspace_id: string | null }>();
    expect(back?.selected_workspace_id).toBe(WS);

    // Settle the command deliveries so later tests start from a clean queue.
    await deliverAll();
  });

  it('separates delivery outcomes honestly: 500/malformed/timeout unknown, 400 known, 429 bounded retry', async () => {
    const source = await env.DB
      .prepare(`SELECT id FROM messages_in WHERE external_id = 'test_bot:7101'`)
      .first<{ id: string }>();
    const sourceId = String(source!.id);
    const insertDelivery = async (id: string, text: string, chat = '777002') => {
      const now = nowIso();
      await env.DB.prepare(
        `INSERT INTO outbox (id, workspace_id, destination, topic, payload_json, status, created_at, updated_at)
         VALUES (?, ?, 'telegram', 'send_message', ?, 'pending', ?, ?)`,
      )
        .bind(
          id,
          WS,
          JSON.stringify({
            payload_version: 1,
            user_id: HUNOR,
            workspace_id: WS,
            chat_id: '',
            bot_installation_id: 'test_bot',
            telegram_user_id: '777002',
            telegram_chat_id: chat,
            source_message_id: sourceId,
            run_id: null,
            kind: 'admin',
            key: id,
            part_index: 0,
            part_count: 1,
            previous_part_id: null,
            clarification_id: null,
            text,
            telegram_message_id: null,
          }),
          now,
          now,
        )
        .run();
    };

    let probeMs = Math.max(deliveryNowMs, Date.parse('2026-10-04T09:00:00.000Z'));
    const nextProbeClock = () => {
      probeMs += 2_000;
      deliveryNowMs = Math.max(deliveryNowMs, probeMs);
      return () => new Date(probeMs).toISOString();
    };

    // HTTP 500 carrying ok:true must never be delivered (first-pass regression).
    await insertDelivery('dlv_probe_500', 'probe 500');
    const probe500 = fetchReplies([{ status: 500, json: { ok: true, result: { message_id: 111, chat: { id: 777002 } } } }]);
    await deliverTelegramOutbox(env.DB, env, { fetchFn: probe500.fn, clock: nextProbeClock() });
    expect(
      (await env.DB.prepare(`SELECT status FROM outbox WHERE id = 'dlv_probe_500'`).first<{ status: string }>())?.status,
    ).toBe('outcome_unknown');

    // Malformed 200 body and transport timeout are unknown too.
    await insertDelivery('dlv_probe_bad_json', 'probe bad json');
    const badJson = fetchReplies([{ status: 200, json: { ok: 'maybe' } }]);
    await deliverTelegramOutbox(env.DB, env, { fetchFn: badJson.fn, clock: nextProbeClock() });
    expect(
      (await env.DB.prepare(`SELECT status FROM outbox WHERE id = 'dlv_probe_bad_json'`).first<{ status: string }>())?.status,
    ).toBe('outcome_unknown');

    await insertDelivery('dlv_probe_timeout', 'probe timeout');
    const timeout = fetchReplies([{ throwError: true }]);
    await deliverTelegramOutbox(env.DB, env, { fetchFn: timeout.fn, clock: nextProbeClock() });
    expect(
      (await env.DB.prepare(`SELECT status FROM outbox WHERE id = 'dlv_probe_timeout'`).first<{ status: string }>())?.status,
    ).toBe('outcome_unknown');

    // Explicit 400 is a known terminal failure.
    await insertDelivery('dlv_probe_400', 'probe 400');
    const rejected = fetchReplies([{ status: 400, json: { ok: false, error_code: 400, description: 'chat not found' } }]);
    await deliverTelegramOutbox(env.DB, env, { fetchFn: rejected.fn, clock: nextProbeClock() });
    expect(
      (await env.DB.prepare(`SELECT status FROM outbox WHERE id = 'dlv_probe_400'`).first<{ status: string }>())?.status,
    ).toBe('failed_known');

    // 429 respects retry_after and the attempt bound with a fresh clock.
    await insertDelivery('dlv_probe_429', 'probe 429');
    const flood = fetchReplies([
      { status: 429, json: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 2 } } },
      { status: 200, json: { ok: true, result: { message_id: 222, chat: { id: 777002, type: 'private' } } } },
    ]);
    const base = probeMs + 2_000;
    probeMs = base;
    await deliverTelegramOutbox(env.DB, env, {
      fetchFn: flood.fn,
      clock: () => new Date(base).toISOString(),
    });
    const afterFlood = await env.DB
      .prepare(`SELECT status, attempt_count, next_retry_at FROM outbox WHERE id = 'dlv_probe_429'`)
      .first<{ status: string; attempt_count: number; next_retry_at: string | null }>();
    expect(afterFlood?.status).toBe('pending');
    expect(Number(afterFlood?.attempt_count)).toBe(1);
    expect(String(afterFlood?.next_retry_at) > new Date(base).toISOString()).toBe(true);

    // Not due yet: a paused reader must not claim it early.
    await deliverTelegramOutbox(env.DB, env, {
      fetchFn: flood.fn,
      clock: () => new Date(base + 1_000).toISOString(),
    });
    expect(flood.count()).toBe(1);

    // Due after retry_after: succeeds within the attempt bound.
    await deliverTelegramOutbox(env.DB, env, {
      fetchFn: flood.fn,
      clock: () => new Date(base + 3_000).toISOString(),
    });
    const settled = await env.DB
      .prepare(`SELECT status FROM outbox WHERE id = 'dlv_probe_429'`)
      .first<{ status: string }>();
    expect(settled?.status).toBe('delivered');

    // Stale sending rows from a terminal run become outcome_unknown, with no HTTP.
    const stale = fetchReplies([{ status: 200, json: { ok: true } }]);
    await insertDelivery('dlv_probe_stale', 'probe stale');
    await env.DB
      .prepare(`UPDATE outbox SET status = 'sending', claimed_by = 'dlv_dead', last_attempt_at = ? WHERE id = 'dlv_probe_stale'`)
      .bind('2000-01-01T00:00:00.000Z')
      .run();
    // Cron discovery: a terminal run that left only a crashed sending row
    // must still surface its workspace in the bounded scan.
    expect(await scanTelegramDue(env.DB)).toContain(WS);
    await deliverTelegramOutbox(env.DB, env, { fetchFn: stale.fn, clock: nextProbeClock() });
    expect(stale.count()).toBe(0);
    expect(
      (await env.DB.prepare(`SELECT status FROM outbox WHERE id = 'dlv_probe_stale'`).first<{ status: string }>())?.status,
    ).toBe('outcome_unknown');

    // Ambiguous or inconsistent rejection envelopes stay unknown and are
    // never retried (third-pass): empty HTTP 429, HTTP 500 carrying an
    // error_code 429, HTTP 429 carrying ok:true, HTTP 403 carrying an
    // error_code 429. Only a matching explicit ok:false envelope classifies.
    const ambiguousProbes: Array<{ id: string; status: number; json?: unknown; empty?: boolean }> = [
      { id: 'dlv_probe_429_empty', status: 429, empty: true },
      { id: 'dlv_probe_500_429', status: 500, json: { ok: false, error_code: 429, description: 'mismatch' } },
      { id: 'dlv_probe_429_ok', status: 429, json: { ok: true, result: { message_id: 1, chat: { id: 777002 } } } },
      { id: 'dlv_probe_403_429', status: 403, json: { ok: false, error_code: 429, description: 'mismatch' } },
    ];
    for (const probe of ambiguousProbes) {
      await insertDelivery(probe.id, `ambiguous ${probe.status}`);
      const probeFetch = fetchReplies([{ status: probe.status, json: probe.json, empty: probe.empty }]);
      await deliverTelegramOutbox(env.DB, env, { fetchFn: probeFetch.fn, clock: nextProbeClock() });
      const probeRow = await env.DB
        .prepare(`SELECT status, next_retry_at FROM outbox WHERE id = ?`)
        .bind(probe.id)
        .first<{ status: string; next_retry_at: string | null }>();
      expect(probeRow?.status).toBe('outcome_unknown');
      expect(probeRow?.next_retry_at).toBeNull();
    }

    // Real HTTP 403 is a known terminal failure even though the status is
    // non-2xx.
    await insertDelivery('dlv_probe_403', 'probe 403');
    const forbidden = fetchReplies([
      { status: 403, json: { ok: false, error_code: 403, description: 'bot was blocked by the user' } },
    ]);
    await deliverTelegramOutbox(env.DB, env, { fetchFn: forbidden.fn, clock: nextProbeClock() });
    expect(
      (await env.DB.prepare(`SELECT status FROM outbox WHERE id = 'dlv_probe_403'`).first<{ status: string }>())?.status,
    ).toBe('failed_known');

    // Retry deadline uses the actual response time, not the pre-fetch time:
    // a ten-second send plus retry_after 5 must be due at t0 + 15s.
    await insertDelivery('dlv_probe_slow429', 'probe slow 429');
    let nowMs = Date.parse('2026-10-04T10:00:00.000Z');
    const slowFlood = async (): Promise<Response> => {
      nowMs += 10_000;
      return new Response(
        JSON.stringify({ ok: false, error_code: 429, description: 'flood', parameters: { retry_after: 5 } }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      );
    };
    await deliverTelegramOutbox(env.DB, env, {
      fetchFn: slowFlood,
      clock: () => new Date(nowMs).toISOString(),
    });
    const slowRow = await env.DB
      .prepare(`SELECT status, next_retry_at FROM outbox WHERE id = 'dlv_probe_slow429'`)
      .first<{ status: string; next_retry_at: string | null }>();
    expect(slowRow?.status).toBe('pending');
    expect(slowRow?.next_retry_at).toBe(new Date(Date.parse('2026-10-04T10:00:15.000Z')).toISOString());

    // Settle the remaining retryable probes so later tests start clean.
    const settle = fetchReplies([
      { status: 200, json: { ok: true, result: { message_id: 800, chat: { id: 777002, type: 'private' } } } },
    ]);
    await deliverTelegramOutbox(env.DB, env, {
      fetchFn: settle.fn,
      clock: () => '2026-10-04T12:00:00.000Z',
    });
  });

  it('keeps per-chat exclusivity and pacing across overlapping consumers', async () => {
    const source = await env.DB
      .prepare(`SELECT id FROM messages_in WHERE external_id = 'test_bot:7101'`)
      .first<{ id: string }>();
    const sourceId = String(source!.id);
    const insertDelivery = async (id: string, text: string) => {
      const now = nowIso();
      await env.DB.prepare(
        `INSERT INTO outbox (id, workspace_id, destination, topic, payload_json, status, created_at, updated_at)
         VALUES (?, ?, 'telegram', 'send_message', ?, 'pending', ?, ?)`,
      )
        .bind(
          id,
          WS,
          JSON.stringify({
            payload_version: 1, user_id: HUNOR, workspace_id: WS, chat_id: '', bot_installation_id: 'test_bot',
            telegram_user_id: '777002', telegram_chat_id: '777002', source_message_id: sourceId, run_id: null,
            kind: 'admin', key: id, part_index: 0, part_count: 1, previous_part_id: null,
            clarification_id: null, text, telegram_message_id: null,
          }),
          now,
          now,
        )
        .run();
    };
    await insertDelivery('dlv_chat_a', 'first in chat');
    await insertDelivery('dlv_chat_b', 'second in chat');

    let releaseFirst: (() => void) | null = null;
    let firstCalls = 0;
    const gated = async (): Promise<Response> => {
      firstCalls += 1;
      return new Promise<Response>((resolve) => {
        releaseFirst = () =>
          resolve(
            new Response(JSON.stringify({ ok: true, result: { message_id: 700, chat: { id: 777002, type: 'private' } } }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
      });
    };
    deliveryNowMs = Math.max(deliveryNowMs, Date.parse('2026-10-04T13:00:00.000Z'));
    const t0 = deliveryNowMs;
    const first = deliverTelegramOutbox(env.DB, env, { fetchFn: gated, clock: () => new Date(t0).toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(firstCalls).toBe(1);
    expect(releaseFirst).toBeTruthy();

    // Overlapping consumer: the atomic claim must refuse the same chat while
    // the first send is in flight.
    const overlapping = fetchReplies([{ status: 200, json: { ok: true, result: { message_id: 701, chat: { id: 777002 } } } }]);
    await deliverTelegramOutbox(env.DB, env, { fetchFn: overlapping.fn, clock: () => new Date(t0).toISOString() });
    expect(overlapping.count()).toBe(0);

    releaseFirst!();
    await first;
    expect(
      (await env.DB.prepare(`SELECT status FROM outbox WHERE id = 'dlv_chat_a'`).first<{ status: string }>())?.status,
    ).toBe('delivered');

    // Completed-send pacing: the same chat is not eligible again within the
    // pacing second, but is after it.
    const paced = fetchReplies([{ status: 200, json: { ok: true, result: { message_id: 702, chat: { id: 777002 } } } }]);
    await deliverTelegramOutbox(env.DB, env, { fetchFn: paced.fn, clock: () => new Date(t0).toISOString() });
    expect(paced.count()).toBe(0);
    await deliverTelegramOutbox(env.DB, env, { fetchFn: paced.fn, clock: () => new Date(t0 + 2_000).toISOString() });
    expect(paced.count()).toBe(1);
    expect(
      (await env.DB.prepare(`SELECT status FROM outbox WHERE id = 'dlv_chat_b'`).first<{ status: string }>())?.status,
    ).toBe('delivered');
  });

  it('splits long text ordered and intact, and a blocked part starves no unrelated reply', async () => {
    // Long plain text with diacritics, emoji and markup characters.
    const long = 'Bistro Paprika — „seful” a confirmat:\n' + 'rând cu diacritice și emoji 🥨 <>&'.repeat(120);
    const source = await env.DB
      .prepare(`SELECT id FROM messages_in WHERE external_id = 'test_bot:7101'`)
      .first<{ id: string }>();
    const sourceId = String(source!.id);
    const insertParts = async (prefix: string, text: string) => {
      const now = nowIso();
      const statements: D1PreparedStatement[] = [];
      const { splitTelegramText } = await import('@otis/channels');
      const parts = splitTelegramText(text);
      parts.forEach((part, index) => {
        statements.push(
          env.DB
            .prepare(
              `INSERT INTO outbox (id, workspace_id, destination, topic, payload_json, status, created_at, updated_at)
               VALUES (?, ?, 'telegram', 'send_message', ?, 'pending', ?, ?)`,
            )
            .bind(
              `${prefix}_${index}`,
              WS,
              JSON.stringify({
                payload_version: 1,
                user_id: HUNOR,
                workspace_id: WS,
                chat_id: '',
                bot_installation_id: 'test_bot',
                telegram_user_id: '777002',
                telegram_chat_id: '777002',
                source_message_id: sourceId,
                run_id: null,
                kind: 'final',
                key: prefix,
                part_index: index,
                part_count: parts.length,
                previous_part_id: index === 0 ? null : `${prefix}_${index - 1}`,
                clarification_id: null,
                text: part,
                telegram_message_id: null,
              }),
              now,
              now,
            ),
        );
      });
      await env.DB.batch(statements);
      return parts;
    };

    // Two rows for the same chat: exactly one is eligible at a time, and an
    // unknown predecessor blocks the later part regardless of LIMIT.
    const parts = await insertParts('dlv_long', long);
    expect(parts.length).toBeGreaterThan(1);
    const blocked = fetchReplies([
      { status: 500, json: { ok: false, error_code: 500, description: 'boom' } },
      { status: 200, json: { ok: true, result: { message_id: 333, chat: { id: 777002 } } } },
    ]);
    deliveryNowMs = Math.max(deliveryNowMs, Date.parse('2026-10-04T14:00:00.000Z'));
    await deliverTelegramOutbox(env.DB, env, { fetchFn: blocked.fn, clock: deliveryClock });
    expect(blocked.count()).toBe(1); // only the first part was attempted
    const statuses = await env.DB
      .prepare(`SELECT id, status FROM outbox WHERE id LIKE 'dlv_long_%' ORDER BY id ASC`)
      .all<{ id: string; status: string }>();
    expect(statuses.results?.[0]?.status).toBe('outcome_unknown');
    expect(statuses.results?.[1]?.status).toBe('pending');

    // Another ready conversation is not starved by held rows (selection
    // excludes blocked parts before LIMIT).
    await insertParts('dlv_other', 'unrelated ready reply');
    const ordered = fetchReplies([
      { status: 200, json: { ok: true, result: { message_id: 444, chat: { id: 777002 } } } },
    ]);
    advanceDeliveryClock(2_000);
    await deliverTelegramOutbox(env.DB, env, { fetchFn: ordered.fn, clock: deliveryClock });
    expect(ordered.count()).toBeGreaterThanOrEqual(1);
    const otherStatus = await env.DB
      .prepare(`SELECT status FROM outbox WHERE id = 'dlv_other_0'`)
      .first<{ status: string }>();
    expect(otherStatus?.status).toBe('delivered');
  });

  it('entrypoint queue handler wakes multipart and 429 continuations without cron', async () => {
    // Earlier tests used injected clocks; clear pacing residue so the real
    // entrypoint clock can attempt the rows it seeds.
    await env.DB
      .prepare(`UPDATE outbox SET last_attempt_at = '2020-01-01T00:00:00.000Z' WHERE destination = 'telegram' AND last_attempt_at IS NOT NULL`)
      .run();
    const source = await env.DB
      .prepare(`SELECT id FROM messages_in WHERE external_id = 'test_bot:7101'`)
      .first<{ id: string }>();
    const sourceId = String(source!.id);
    const queueSends: Array<{ body: { kind?: string; workspace_id?: string }; options?: { delaySeconds?: number } }> = [];
    const queueEnv = {
      ...env,
      TELEGRAM_SEND_TRANSPORT: okFetch,
      DISPATCH_QUEUE: {
        send: async (body: { kind?: string; workspace_id?: string }, options?: { delaySeconds?: number }) => {
          queueSends.push({ body, options });
        },
      },
    } as unknown as typeof env;
    const runDelivery = async () => {
      await worker.queue(
        { messages: [{ body: { kind: 'telegram_delivery', workspace_id: WS } }] } as unknown as Parameters<typeof worker.queue>[0],
        queueEnv,
      );
    };
    const insertPart = async (id: string, text: string, previousPartId: string | null) => {
      const now = nowIso();
      await env.DB
        .prepare(
          `INSERT INTO outbox (id, workspace_id, destination, topic, payload_json, status, created_at, updated_at)
           VALUES (?, ?, 'telegram', 'send_message', ?, 'pending', ?, ?)`,
        )
        .bind(
          id,
          WS,
          JSON.stringify({
            payload_version: 1, user_id: HUNOR, workspace_id: WS, chat_id: '', bot_installation_id: 'test_bot',
            telegram_user_id: '777002', telegram_chat_id: '777002', source_message_id: sourceId, run_id: null,
            kind: 'final', key: id, part_index: previousPartId ? 1 : 0, part_count: previousPartId ? 2 : 1,
            previous_part_id: previousPartId, clarification_id: null, text, telegram_message_id: null,
          }),
          now,
          now,
        )
        .run();
    };

    // Multipart continuation: part zero goes out now, and the queue handler
    // must publish a delayed hint that reaches part one without cron.
    await insertPart('dlv_wake_0', 'first wake part', null);
    await insertPart('dlv_wake_1', 'second wake part', 'dlv_wake_0');
    const sendsBefore = sent.length;
    await runDelivery();
    expect(sent.length).toBe(sendsBefore + 1);
    expect(
      (await env.DB.prepare(`SELECT status FROM outbox WHERE id = 'dlv_wake_0'`).first<{ status: string }>())?.status,
    ).toBe('delivered');
    expect(
      (await env.DB.prepare(`SELECT status FROM outbox WHERE id = 'dlv_wake_1'`).first<{ status: string }>())?.status,
    ).toBe('pending');
    const partHint = queueSends[queueSends.length - 1]!;
    expect(partHint.body).toEqual({ kind: 'telegram_delivery', workspace_id: WS });
    expect(partHint.options?.delaySeconds).toBeGreaterThanOrEqual(1);
    expect(partHint.options?.delaySeconds).toBeLessThanOrEqual(300);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const sendsBeforePartTwo = sent.length;
    await runDelivery();
    expect(sent.length).toBe(sendsBeforePartTwo + 1);
    expect(
      (await env.DB.prepare(`SELECT status FROM outbox WHERE id = 'dlv_wake_1'`).first<{ status: string }>())?.status,
    ).toBe('delivered');

    // 429 continuation: the delayed hint respects retry_after and the next
    // invocation delivers without invoking the scheduled cron sweep.
    await insertPart('dlv_wake_429', 'rate limited wake', null);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    queueEnv.TELEGRAM_SEND_TRANSPORT = fetchReplies([
      { status: 429, json: { ok: false, error_code: 429, description: 'flood', parameters: { retry_after: 1 } } },
    ]).fn;
    await runDelivery();
    const retryRow = await env.DB
      .prepare(`SELECT status, next_retry_at FROM outbox WHERE id = 'dlv_wake_429'`)
      .first<{ status: string; next_retry_at: string | null }>();
    expect(retryRow?.status).toBe('pending');
    expect(retryRow?.next_retry_at).not.toBeNull();
    const retryHint = queueSends[queueSends.length - 1]!;
    expect(retryHint.body).toEqual({ kind: 'telegram_delivery', workspace_id: WS });
    expect(retryHint.options?.delaySeconds).toBeGreaterThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    queueEnv.TELEGRAM_SEND_TRANSPORT = okFetch;
    await runDelivery();
    expect(
      (await env.DB.prepare(`SELECT status FROM outbox WHERE id = 'dlv_wake_429'`).first<{ status: string }>())?.status,
    ).toBe('delivered');

    // Blocked chain: an unknown part zero leaves part one ineligible, so no
    // continuation hint is published for it.
    await insertPart('dlv_wake_block_0', 'blocked part zero', null);
    await insertPart('dlv_wake_block_1', 'blocked part one', 'dlv_wake_block_0');
    const blockedFetch = fetchReplies([
      { status: 500, json: { ok: false, error_code: 500, description: 'boom' } },
    ]);
    queueEnv.TELEGRAM_SEND_TRANSPORT = blockedFetch.fn;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const hintsBeforeBlocked = queueSends.length;
    await runDelivery();
    expect(blockedFetch.count()).toBe(1);
    expect(
      (await env.DB.prepare(`SELECT status FROM outbox WHERE id = 'dlv_wake_block_0'`).first<{ status: string }>())?.status,
    ).toBe('outcome_unknown');
    expect(
      (await env.DB.prepare(`SELECT status FROM outbox WHERE id = 'dlv_wake_block_1'`).first<{ status: string }>())?.status,
    ).toBe('pending');
    expect(queueSends.length).toBe(hintsBeforeBlocked);
  });

  it('queue dispatch continuation wakes checkpoint, budget and contention slices without cron', async () => {
    // Queue forwards each workspace once to its actor; the actor owns
    // execution, delivery and continuation hints. Per-call env copies cannot
    // cross the isolate boundary, so this test installs scripted handlers and
    // queue observers on the real env (saved/restored) and drives
    // worker.queue with the real env.
    const realEnv = env as unknown as Record<string, unknown>;
    const queueSends: Array<{ body: { kind?: string; workspace_id?: string }; options?: { delaySeconds?: number } }> = [];
    const runQueueReal = async (body: unknown) => {
      await worker.queue(
        { messages: [{ body }] } as unknown as Parameters<typeof worker.queue>[0],
        env,
      );
    };
    const dispatchHints = () => queueSends.filter((send) => send.body.workspace_id === WS && send.body.kind === undefined);
    const withRealEnv = async <T>(overrides: Record<string, unknown>, fn: () => Promise<T>): Promise<T> => {
      const saved = new Map<string, unknown>();
      for (const [key, value] of Object.entries(overrides)) {
        saved.set(key, realEnv[key]);
        realEnv[key] = value;
      }
      try {
        return await fn();
      } finally {
        for (const [key] of Object.entries(overrides)) {
          const prior = saved.get(key);
          if (prior === undefined) delete realEnv[key];
          else realEnv[key] = prior;
        }
      }
    };

    // Settle queued runs left by earlier tests so the scripted handler only
    // sees this test's runs.
    for (let i = 0; i < 6; i += 1) {
      const queued = await env.DB
        .prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE workspace_id = ? AND status = 'queued'`)
        .bind(WS)
        .first<{ n: number }>();
      if (Number(queued?.n ?? 0) === 0) break;
      await withRealEnv({ USE_ECHO_HANDLER: 'true' }, () => runQueueReal({ workspace_id: WS }));
    }

    // Checkpoint second slice: the first queue invocation defers with a
    // checkpoint and schedules the next workspace wake; processing that wake
    // finishes the run without any scheduled() cron invocation. worker.queue
    // awaits the actor's sync execution, so hints are published before it
    // resolves.
    const accepted = (await (await postWebhook(textUpdate(7701, 777002, 'Long turn needing a second slice.'))).json()) as {
      run_id: string;
    };
    let slices = 0;
    const scripted: TurnHandler = {
      name: 'scripted-second-slice',
      async runTurn() {
        slices += 1;
        return slices === 1
          ? { kind: 'continuation', progressJson: JSON.stringify({ step: 1 }) }
          : { kind: 'completed', replyText: 'Second slice complete.' };
      },
    };
    const hintsBefore = dispatchHints().length;
    await withRealEnv(
      {
        DISPATCH_TEST_HANDLER: scripted,
        DISPATCH_QUEUE: {
          send: async (body: { kind?: string; workspace_id?: string }, options?: { delaySeconds?: number }) => {
            queueSends.push({ body, options });
          },
        },
      },
      () => runQueueReal({ workspace_id: WS }),
    );
    expect(slices).toBe(1);
    const checkpointHint = dispatchHints()[hintsBefore]!;
    expect(checkpointHint).toBeTruthy();
    expect(checkpointHint.options?.delaySeconds).toBe(1);
    await withRealEnv({ DISPATCH_TEST_HANDLER: scripted }, () => runQueueReal(checkpointHint.body));
    expect(slices).toBe(2);
    expect(
      (await env.DB.prepare(`SELECT status FROM agent_runs WHERE id = ?`).bind(accepted.run_id).first<{ status: string }>())?.status,
    ).toBe('succeeded');
    expect(dispatchHints().length).toBe(hintsBefore + 1);

    // waiting_for_input creates no continuation hint.
    const waiting = (await (await postWebhook(textUpdate(7702, 777002, 'This one needs a question.'))).json()) as {
      run_id: string;
    };
    const askHandler: TurnHandler = {
      name: 'scripted-ask',
      async runTurn() {
        return { kind: 'needs_input', question: 'Which one?', intendedOperation: 'create_task', missingFields: ['due'] };
      },
    };
    const hintsBeforeWaiting = dispatchHints().length;
    await withRealEnv(
      {
        DISPATCH_TEST_HANDLER: askHandler,
        DISPATCH_QUEUE: {
          send: async (body: { kind?: string; workspace_id?: string }, options?: { delaySeconds?: number }) => {
            queueSends.push({ body, options });
          },
        },
      },
      () => runQueueReal({ workspace_id: WS }),
    );
    expect(dispatchHints().length).toBe(hintsBeforeWaiting);
    expect(
      (await env.DB.prepare(`SELECT status FROM agent_runs WHERE id = ?`).bind(waiting.run_id).first<{ status: string }>())?.status,
    ).toBe('waiting_for_input');

    // Held lease: contention backs off with a bounded delayed hint instead
    // of spinning an immediate one.
    const contended = (await (await postWebhook(textUpdate(7703, 777002, 'Contended slice.'))).json()) as {
      run_id: string;
    };
    await claimWorkspaceLease(env.DB, { workspaceId: WS, attemptId: 'other-attempt', ttlSeconds: 60, nowIso: nowIso() });
    const hintsBeforeContention = dispatchHints().length;
    await withRealEnv(
      {
        DISPATCH_QUEUE: {
          send: async (body: { kind?: string; workspace_id?: string }, options?: { delaySeconds?: number }) => {
            queueSends.push({ body, options });
          },
        },
      },
      () => runQueueReal({ workspace_id: WS }),
    );
    const contentionHint = dispatchHints()[hintsBeforeContention]!;
    expect(contentionHint).toBeTruthy();
    expect(contentionHint.options?.delaySeconds).toBe(5);
    expect(
      (await env.DB.prepare(`SELECT status FROM agent_runs WHERE id = ?`).bind(contended.run_id).first<{ status: string }>())?.status,
    ).toBe('queued');
    await releaseWorkspaceLease(env.DB, { workspaceId: WS, attemptId: 'other-attempt' });

    // Cleanup: settle the contended run with the deterministic echo handler.
    await withRealEnv({ USE_ECHO_HANDLER: 'true' }, () => runQueueReal({ workspace_id: WS }));
    expect(
      (await env.DB.prepare(`SELECT status FROM agent_runs WHERE id = ?`).bind(contended.run_id).first<{ status: string }>())?.status,
    ).toBe('succeeded');

    // A failing hint publish is best-effort: the queue handler still
    // resolves and the deferred run stays durable for the cron backstop.
    const failingRun = (await (await postWebhook(textUpdate(7704, 777002, 'Failing hint publish.'))).json()) as {
      run_id: string;
    };
    let failSlice = 0;
    const failScripted: TurnHandler = {
      name: 'fail-hint',
      async runTurn() {
        failSlice += 1;
        return failSlice === 1
          ? { kind: 'continuation', progressJson: '{}' }
          : { kind: 'completed', replyText: 'ok' };
      },
    };
    let failingSends = 0;
    await withRealEnv(
      {
        DISPATCH_TEST_HANDLER: failScripted,
        DISPATCH_QUEUE: {
          send: async () => {
            failingSends += 1;
            throw new Error('synthetic queue failure');
          },
        },
      },
      () => runQueueReal({ workspace_id: WS }),
    );
    expect(failingSends).toBe(1);
    expect(
      (await env.DB.prepare(`SELECT status FROM agent_runs WHERE id = ?`).bind(failingRun.run_id).first<{ status: string }>())?.status,
    ).toBe('queued');
    // Settle the deferred run for later tests.
    await withRealEnv({ USE_ECHO_HANDLER: 'true' }, () => runQueueReal({ workspace_id: WS }));
  });

  it('cancels queued deliveries when membership or the source binding is revoked, with no send', async () => {
    await env.DB
      .prepare(`UPDATE outbox SET status = 'cancelled' WHERE destination = 'telegram' AND status = 'pending'`)
      .run();
    await env.DB
      .prepare(`UPDATE outbox SET last_attempt_at = '2020-01-01T00:00:00.000Z' WHERE destination = 'telegram' AND last_attempt_at IS NOT NULL`)
      .run();
    const source = await env.DB
      .prepare(`SELECT id FROM messages_in WHERE external_id = 'test_bot:7101'`)
      .first<{ id: string }>();
    const sourceId = String(source!.id);
    const insertDelivery = async (id: string, text: string) => {
      const now = nowIso();
      await env.DB.prepare(
        `INSERT INTO outbox (id, workspace_id, destination, topic, payload_json, status, created_at, updated_at)
         VALUES (?, ?, 'telegram', 'send_message', ?, 'pending', ?, ?)`,
      )
        .bind(
          id,
          WS,
          JSON.stringify({
            payload_version: 1, user_id: HUNOR, workspace_id: WS, chat_id: '', bot_installation_id: 'test_bot',
            telegram_user_id: '777002', telegram_chat_id: '777002', source_message_id: sourceId, run_id: null,
            kind: 'admin', key: id, part_index: 0, part_count: 1, previous_part_id: null,
            clarification_id: null, text, telegram_message_id: null,
          }),
          now,
          now,
        )
        .run();
    };
    const okBody = { status: 200, json: { ok: true, result: { message_id: 901, chat: { id: 777002, type: 'private' } } } };
    // Move the deterministic clock clear of any stamp written by earlier
    // cases in this file (their frozen or live last_attempt_at can otherwise
    // sit inside the one-second pacing window and hide these rows).
    deliveryNowMs = Math.max(deliveryNowMs, Date.parse('2026-10-04T15:00:00.000Z'), Date.now() + 60_000) + 10_000;

    // Membership revoked before the send: cancelled, zero HTTP.
    await insertDelivery('dlv_revoke_member', 'membership revoked');
    await env.DB.prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`).bind(WS, HUNOR).run();
    const revokedMember = fetchReplies([okBody]);
    await deliverTelegramOutbox(env.DB, env, { fetchFn: revokedMember.fn, clock: deliveryClock, workspaceId: WS });
    expect(revokedMember.count()).toBe(0);
    expect(
      (await env.DB.prepare(`SELECT status FROM outbox WHERE id = 'dlv_revoke_member'`).first<{ status: string }>())?.status,
    ).toBe('cancelled');
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'member', ?, ?, ?)`,
    )
      .bind(WS, HUNOR, now, now, now)
      .run();

    // Original binding removed: the destination can no longer be proven.
    await insertDelivery('dlv_revoke_binding', 'binding revoked');
    await env.DB.prepare(`DELETE FROM telegram_users WHERE telegram_user_id = '777002'`).run();
    const revokedBinding = fetchReplies([okBody]);
    await deliverTelegramOutbox(env.DB, env, { fetchFn: revokedBinding.fn, clock: deliveryClock, workspaceId: WS });
    expect(revokedBinding.count()).toBe(0);
    expect(
      (await env.DB.prepare(`SELECT status FROM outbox WHERE id = 'dlv_revoke_binding'`).first<{ status: string }>())?.status,
    ).toBe('cancelled');
    await env.DB.prepare(
      `INSERT INTO telegram_users (telegram_user_id, user_id, selected_workspace_id, active_chat_id, created_at, updated_at)
       VALUES ('777002', ?, ?, NULL, ?, ?)`,
    )
      .bind(HUNOR, WS, now, now)
      .run();
  });

  it('streams private-chat drafts and typing from a live telegram turn', async () => {
    // Full turn through the real handler: typing pings immediately, preview
    // frames fold into one stable coalesced draft, and the draft clears when
    // the turn ends. Durable final delivery still flows through the outbox.
    const res = await postWebhook(textUpdate(7851, 777002, 'Draft my reply live'));
    const accepted = (await res.json()) as { status: string; run_id: string };
    expect(accepted.status).toBe('accepted');

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch = (async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as typeof fetch;
    const adapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [{ kind: 'text_chunks', chunks: ['Draft ', 'preview live.'] }],
    });
    const handler = new AgentHandler({
      providerAdapter: adapter,
      limits: { maxDailyActions: 50, maxRoundsPerRun: 10 },
      telegramBotToken: 'test_bot_token',
      fetchFn: fakeFetch,
    });
    const dispatched = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), WS, { handler });
    expect(dispatched.status).toBe('completed');

    const typing = calls.filter((call) => call.url.includes('/sendChatAction'));
    expect(typing.length).toBeGreaterThanOrEqual(1);
    const drafts = calls.filter((call) => call.url.includes('/sendMessageDraft'));
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    const draftIds = new Set(drafts.map((call) => call.body['draft_id']));
    expect(draftIds.size).toBe(1);
    expect(typeof [...draftIds][0]).toBe('number');
    expect(drafts.every((call) => String(call.body['chat_id']) === '777002')).toBe(true);
    expect(String(drafts[0]!.body['text'])).toContain('Draft');
    // Terminal clear so no stale preview outlives the turn.
    expect(drafts[drafts.length - 1]!.body['text']).toBe('');

    // The durable reply still commits through the existing final path.
    const answer = await env.DB.prepare(`SELECT content_text FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`).bind(accepted.run_id).first<{ content_text: string }>();
    expect(answer?.content_text).toContain('Draft preview live.');
  });

  it('disconnect invalidates unused codes, cancels pending deliveries, and revokes the binding', async () => {
    // A deep link issued now must not work after a disconnect; plus a pending
    // delivery for Avi (777001).
    const staleLink = await issueLink(aviCookie);
    const now = nowIso();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO link_codes (id, code_hash, user_id, requested_workspace_id, created_at, expires_at, consumed_at)
       VALUES ('lc_discard_me', 'hash_discard_me', ?, ?, ?, ?, NULL)`,
    )
      .bind(AVI, WS, now, new Date(Date.now() + 600_000).toISOString())
      .run();
    await env.DB.prepare(
      `INSERT INTO outbox (id, workspace_id, destination, topic, payload_json, status, created_at, updated_at)
       VALUES ('dlv_pending_avi', ?, 'telegram', 'send_message', ?, 'pending', ?, ?)`,
    )
      .bind(
        WS,
        JSON.stringify({
          payload_version: 1, user_id: AVI, workspace_id: WS, chat_id: '', bot_installation_id: 'test_bot',
          telegram_user_id: '777001', telegram_chat_id: '777001', source_message_id: '', run_id: null,
          kind: 'admin', key: 'dlv_pending_avi', part_index: 0, part_count: 1, previous_part_id: null,
          clarification_id: null, text: 'pending before disconnect', telegram_message_id: null,
        }),
        now,
        now,
      )
      .run();

    const res = await SELF.fetch(`http://localhost/api/workspaces/${WS}/telegram/connection`, {
      method: 'DELETE',
      headers: { cookie: aviCookie, origin: 'http://localhost', [AUTH_BOUNDS.CSRF_HEADER]: '1' },
    });
    expect(res.status).toBe(200);

    expect(
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM telegram_users WHERE user_id = ?`).bind(AVI).first<{ n: number }>())?.n,
    ).toBe(0);
    expect(
      (await env.DB.prepare(`SELECT status FROM outbox WHERE id = 'dlv_pending_avi'`).first<{ status: string }>())?.status,
    ).toBe('cancelled');
    expect(
      (await env.DB.prepare(`SELECT consumed_at FROM link_codes WHERE id = 'lc_discard_me'`).first<{ consumed_at: string | null }>())?.consumed_at,
    ).not.toBeNull();

    // Idempotent: repeated DELETE still succeeds.
    const again = await SELF.fetch(`http://localhost/api/workspaces/${WS}/telegram/connection`, {
      method: 'DELETE',
      headers: { cookie: aviCookie, origin: 'http://localhost', [AUTH_BOUNDS.CSRF_HEADER]: '1' },
    });
    expect(again.status).toBe(200);

    // The pre-disconnect deep link is dead: Start cannot relink through it.
    const staleStart = await postWebhook(textUpdate(7601, 777001, `/start ${staleLink.code}`));
    expect(((await staleStart.json()) as { status: string }).status).toBe('unrouted');

    // Reconnection is a fresh explicit link, not the old one.
    const fresh = await issueLink(aviCookie);
    const freshStart = await postWebhook(textUpdate(7602, 777001, `/start ${fresh.code}`));
    const freshBody = (await freshStart.json()) as { status: string; user_id?: string };
    expect(freshBody.status).toBe('linked');
    expect(freshBody.user_id).toBe(AVI);
  });
});

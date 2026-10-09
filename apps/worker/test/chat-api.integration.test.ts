import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
import { AUTH_BOUNDS } from '@otis/contracts';
import type {
  ActionDetailResponse,
  ActivityPageResponse,
  ChatDetailResponse,
  MessageListResponse,
  ModelListResponse,
  RunDetailResponse,
  RunBatchResponse,
  UndoCommitResponse,
  UndoPreviewResponse,
  ClarificationListResponse,
} from '@otis/contracts';
import { acceptWebMessage, createChat } from '../src/inbox/repository.js';
import { createActivityStream } from '../src/chat/stream.js';
import { handleCreateMessage } from '../src/routes/chats.js';
import { publishDispatchHint } from '../src/dispatchHint.js';
import { executeLedgerCommand, getWorkspaceRevision, handleCreateEntity, handleCreateTask } from '@otis/ledger';
import { PRODUCTION_REGISTRY } from '@otis/agent';
import { sha256, verifySession } from '@otis/identity';

const CSRF = {
  origin: 'http://localhost',
  [AUTH_BOUNDS.CSRF_HEADER]: '1',
  'Content-Type': 'application/json',
};

const WS = 'ws-chat-api';
const AVI = 'usr_api_avi';
const HUNOR = 'usr_api_hunor';
const OUTSIDER = 'usr_api_outsider';

let aviCookie: string;
let hunorCookie: string;
let outsiderCookie: string;
let aviChat: string;
let hunorChat: string;


async function call(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('Cookie', init.cookie);
  return SELF.fetch(`http://localhost${path}`, { ...init, headers });
}

async function callJson<T>(path: string, init: RequestInit & { cookie?: string } = {}): Promise<T> {
  const res = await call(path, init);
  const text = await res.text();
  if (res.status >= 500) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed with ${res.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

/**
 * Reads an SSE body with a hard deadline so a test can never wait on an open
 * stream; the reader is cancelled once the expected content has arrived.
 */
async function readAll(response: Response, deadlineMs = 3000): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining));
    const chunk = await Promise.race([reader.read(), timeout]);
    if (chunk === null) break;
    if (chunk.done) break;
    out += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel().catch(() => undefined);
  return out;
}

beforeAll(async () => {
  await applyMigrations(env.DB);

  const now = new Date().toISOString();
  for (const [id, fb, email, name] of [
    [AVI, 'fb_api_avi', 'avi@kerning.test', 'Avi'],
    [HUNOR, 'fb_api_hunor', 'hunor@kerning.test', 'Hunor'],
    [OUTSIDER, 'fb_api_outsider', 'other@elsewhere.test', 'Other'],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, fb, email, name, now, now)
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
     VALUES (?, 'Kerning', ?, 0, 1, ?, ?)`,
  )
    .bind(WS, AVI, now, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
     VALUES ('ws-api-other', 'Other Business', ?, 0, 1, ?, ?)`,
  )
    .bind(OUTSIDER, now, now)
    .run();

  for (const [workspaceId, user, role] of [
    [WS, AVI, 'owner'],
    [WS, HUNOR, 'member'],
    ['ws-api-other', OUTSIDER, 'owner'],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(workspaceId, user, role, now, now, now)
      .run();
  }

  for (const [sid, raw, user] of [
    ['sess_api_avi', 'api_token_avi', AVI],
    ['sess_api_hunor', 'api_token_hunor', HUNOR],
    ['sess_api_outsider', 'api_token_outsider', OUTSIDER],
  ] as const) {
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    )
      .bind(sid, await sha256(raw), user, now, expiresAt, now)
      .run();
    const cookie = `${AUTH_BOUNDS.COOKIE_NAME}=${raw}`;
    if (user === AVI) aviCookie = cookie;
    else if (user === HUNOR) hunorCookie = cookie;
    else outsiderCookie = cookie;
  }

  aviChat = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI, title: 'Avi chat' })).id;
  hunorChat = (await createChat(env.DB, { workspaceId: WS, authorUserId: HUNOR, title: 'Hunor chat' })).id;
});

/** Commits a real ledger write through the executing boundary. */
async function commitEntity(name: string, chatId: string): Promise<string> {
  const accepted = await acceptWebMessage(env.DB, {
    workspaceId: WS,
    chatId,
    userId: AVI,
    clientMessageId: `cm-entity-${name}-${Date.now()}`,
    text: `Create ${name}`,
  });
  const inbound = await env.DB.prepare(`SELECT id FROM messages_in WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(chatId)
    .first<{ id: string }>();
  const revision = await getWorkspaceRevision(env.DB, WS);
  const fenceRow = await env.DB.prepare(`SELECT lease_fence FROM workspaces WHERE id = ?`)
    .bind(WS)
    .first<{ lease_fence: number }>();

  const result = await executeLedgerCommand(
    env.DB,
    {
      workspace_id: WS,
      action_id: `act-${name}-${Date.now()}`,
      expected_business_revision: revision?.business_revision ?? 0,
      actor: { kind: 'member', user_id: AVI },
      membership_revision: 1,
      request_id: `req-${name}`,
      source_message_id: inbound?.id ?? accepted.message_id,
      source_channel: 'web',
      chat_id: chatId,
    },
    'create_entity',
    { name },
    handleCreateEntity,
    undefined,
    { deferRunTransition: true },
  );
  expect(result.status).toBe('applied');
  expect(fenceRow).toBeDefined();
  const stored = (
    await env.DB.prepare(`SELECT action_id FROM action_receipts WHERE workspace_id = ?`).bind(WS).all<{
      action_id: string;
    }>()
  ).results;
  if (!stored.some((row) => row.action_id === result.action_id)) {
    throw new Error(`receipt missing for ${result.action_id}; stored ${JSON.stringify(stored)}`);
  }
  return result.action_id!;
}

describe('Chat API: transcript, activity and run status', () => {
  it('returns chat detail with author flag so a teammate transcript is read-only', async () => {
    const own = await callJson<ChatDetailResponse>(`/api/workspaces/${WS}/chats/${aviChat}`, {
      cookie: aviCookie,
    });
    expect(own.is_author).toBe(true);

    const teammate = await callJson<ChatDetailResponse>(`/api/workspaces/${WS}/chats/${aviChat}`, {
      cookie: hunorCookie,
    });
    expect(teammate.is_author).toBe(false);
  });

  it('rejects with 403 session_mismatch when x-expected-user-id does not match session user (SOL-16)', async () => {
    const res = await call(`/api/workspaces/${WS}/chats`, {
      method: 'POST',
      cookie: hunorCookie,
      headers: {
        ...CSRF,
        'x-expected-user-id': AVI,
      },
      body: JSON.stringify({ client_chat_id: 'chat-mismatch-test' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('session_mismatch');

    const okRes = await call(`/api/workspaces/${WS}/chats`, {
      method: 'POST',
      cookie: hunorCookie,
      headers: {
        ...CSRF,
        'x-expected-user-id': HUNOR,
      },
      body: JSON.stringify({ client_chat_id: 'chat-match-test' }),
    });
    expect(okRes.status).toBe(201);
  });

  it('denies a non-member and does not leak the chat existence', async () => {
    const res = await call(`/api/workspaces/${WS}/chats/${aviChat}`, { cookie: outsiderCookie });
    expect(res.status).toBe(404);

    const messages = await call(`/api/workspaces/${WS}/chats/${aviChat}/messages`, {
      cookie: outsiderCookie,
    });
    expect(messages.status).toBe(404);
  });

  it('paginates messages without duplicates across pages', async () => {
    for (let index = 0; index < 5; index += 1) {
      await acceptWebMessage(env.DB, {
        workspaceId: WS,
        chatId: aviChat,
        userId: AVI,
        clientMessageId: `cm-page-${index}`,
        text: `page message ${index}`,
      });
    }

    const firstPage = await callJson<MessageListResponse>(
      `/api/workspaces/${WS}/chats/${aviChat}/messages?limit=2`,
      { cookie: aviCookie },
    );
    expect(firstPage.messages).toHaveLength(2);
    expect(firstPage.messages.map(message => message.content_text)).toEqual(['page message 3', 'page message 4']);
    expect(firstPage.next_before_sequence).toBe(firstPage.messages[0]!.sequence);

    const secondPage = await callJson<MessageListResponse>(
      `/api/workspaces/${WS}/chats/${aviChat}/messages?limit=2&before_sequence=${firstPage.next_before_sequence}`,
      { cookie: aviCookie },
    );

    const ids = new Set([
      ...firstPage.messages.map((message) => message.id),
      ...secondPage.messages.map((message) => message.id),
    ]);
    expect(ids.size).toBe(firstPage.messages.length + secondPage.messages.length);
  });

  it('rejects an invalid transcript cursor instead of broadening the query', async () => {
    const res = await call(
      `/api/workspaces/${WS}/chats/${aviChat}/messages?before_sequence=not-a-number`,
      { cookie: aviCookie },
    );
    expect(res.status).toBe(422);
  });

  it('returns persisted activity after a cursor and reports the latest chat cursor', async () => {
    const page = await callJson<ActivityPageResponse>(
      `/api/workspaces/${WS}/chats/${aviChat}/activity?after=0`,
      { cookie: aviCookie },
    );
    expect(page.activities.length).toBeGreaterThan(0);
    expect(page.activities[0]!.type).toBe('message_accepted');
    expect(page.next_cursor).toBeGreaterThan(0);
    expect(page.latest_cursor).toBeGreaterThanOrEqual(page.next_cursor);

    const next = await callJson<ActivityPageResponse>(
      `/api/workspaces/${WS}/chats/${aviChat}/activity?after=${page.next_cursor}`,
      { cookie: aviCookie },
    );
    for (const activity of next.activities) {
      expect(activity.cursor).toBeGreaterThan(page.next_cursor);
    }
  });

  it('rejects an activity cursor ahead of the chat with an explicit resync signal', async () => {
    const res = await call(`/api/workspaces/${WS}/chats/${aviChat}/activity?after=99999`, {
      cookie: aviCookie,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details?: { latest_cursor?: number } } };
    expect(body.error.code).toBe('cursor_superseded');
    expect(typeof body.error.details?.latest_cursor).toBe('number');
  });

  it('denies activity to a removed member rather than replaying private rows', async () => {
    const tempUser = 'usr_api_temp';
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
       VALUES (?, 'fb_api_temp', 'temp@kerning.test', 'Temp', ?, ?)`,
    )
      .bind(tempUser, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'member', ?, ?, ?)`,
    )
      .bind(WS, tempUser, now, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
       VALUES ('sess_api_temp', ?, ?, ?, ?, NULL, ?)`,
    )
      .bind(
        await sha256('api_token_temp'),
        tempUser,
        now,
        new Date(Date.now() + 3600 * 1000).toISOString(),
        now,
      )
      .run();

    const tempCookie = `${AUTH_BOUNDS.COOKIE_NAME}=api_token_temp`;
    expect((await call(`/api/workspaces/${WS}/chats/${aviChat}`, { cookie: tempCookie })).status).toBe(200);

    await env.DB.prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .bind(WS, tempUser)
      .run();

    expect((await call(`/api/workspaces/${WS}/chats/${aviChat}`, { cookie: tempCookie })).status).toBe(404);
    expect(
      (await call(`/api/workspaces/${WS}/chats/${aviChat}/activity?after=0`, { cookie: tempCookie })).status,
    ).toBe(404);
  });

  it('opens an SSE stream that replays persisted activity and then closes cleanly', async () => {
    const before = await callJson<ActivityPageResponse>(
      `/api/workspaces/${WS}/chats/${aviChat}/activity?after=0`,
      { cookie: aviCookie },
    );

    const response = createActivityStream(env.DB, {
      workspaceId: WS,
      chatId: aviChat,
      afterCursor: before.next_cursor,
      sessionToken: 'api_token_avi',
      userId: AVI,
      pollIntervalMs: 5,
      maxStreamMs: 60,
      heartbeatMs: 10,
    });
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');

    const body = await readAll(response);
    // The stream starts from the given cursor, so it does not replay old rows.
    expect(body).not.toContain('message_accepted');
  });

  it('replays persisted rows to a reconnecting subscriber from its cursor', async () => {
    const response = createActivityStream(env.DB, {
      workspaceId: WS,
      chatId: aviChat,
      afterCursor: 0,
      sessionToken: 'api_token_avi',
      userId: AVI,
      pollIntervalMs: 5,
      maxStreamMs: 200,
      heartbeatMs: 50,
    });
    const body = await readAll(response);
    expect(body).toContain('event: activity');
    expect(body).toContain('message_accepted');

    const page = await callJson<ActivityPageResponse>(
      `/api/workspaces/${WS}/chats/${aviChat}/activity?after=0`,
      { cookie: aviCookie },
    );
    for (const activity of page.activities) {
      expect(body).toContain(`id: ${activity.cursor}`);
    }
  });

  it('drains every catch-up page before live cursors advance (F09)', async () => {
    const drainChat = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI, title: 'Drain chat' })).id;
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: WS,
      chatId: drainChat,
      userId: AVI,
      clientMessageId: 'cm-drain-1',
      text: 'drain probe',
    });
    const base = await env.DB.prepare(`SELECT COALESCE(MAX(cursor), 0) AS n FROM run_activity WHERE workspace_id = ? AND chat_id = ?`)
      .bind(WS, drainChat)
      .first<{ n: number }>();
    const start = Number(base?.n ?? 0);
    const total = 250;
    const now = new Date().toISOString();
    const inserts = [];
    for (let i = 1; i <= total; i++) {
      inserts.push(
        env.DB.prepare(
          `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, 'text_chunk', ?, ?)`,
        ).bind(`act_drain_${i}`, WS, drainChat, accepted.run_id, start + i, JSON.stringify({ text: `row ${i}` }), now),
      );
    }
    for (let i = 0; i < inserts.length; i += 50) {
      await env.DB.batch(inserts.slice(i, i + 50));
    }
    await env.DB.prepare(`UPDATE chats SET activity_cursor = ?, last_activity_at = ?, updated_at = ? WHERE id = ?`)
      .bind(start + total, now, now, drainChat)
      .run();
    const response = createActivityStream(env.DB, {
      workspaceId: WS,
      chatId: drainChat,
      afterCursor: start,
      sessionToken: 'api_token_avi',
      userId: AVI,
      // No heartbeat beat fits in this window: rows must arrive from the
      // initial drain alone, never from a later catch-up tick.
      maxStreamMs: 300,
      heartbeatMs: 10_000,
    });
    const body = await readAll(response, 15000);
    const seen: number[] = [];
    for (const match of body.matchAll(/^id: (\d+)$/gm)) {
      seen.push(Number(match[1]));
    }
    const catchup = seen.filter(id => id > start);
    // Every catch-up row arrives exactly once, in cursor order, before any
    // newer live cursor could leapfrog it.
    expect(catchup).toHaveLength(total);
    expect(catchup).toEqual([...catchup].sort((a, b) => a - b));
    expect(catchup[0]).toBe(start + 1);
    expect(catchup[catchup.length - 1]).toBe(start + total);
  });

  it('closes the stream for a member whose access was revoked while it was open', async () => {
    const revokedUser = 'usr_api_revoked';
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
       VALUES (?, 'fb_api_revoked', 'revoked@kerning.test', 'Revoked', ?, ?)`,
    )
      .bind(revokedUser, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'member', ?, ?, ?)`,
    )
      .bind(WS, revokedUser, now, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
       VALUES ('sess_api_revoked', ?, ?, ?, ?, NULL, ?)`,
    )
      .bind(
        await sha256('api_token_revoked'),
        revokedUser,
        now,
        new Date(Date.now() + 3600 * 1000).toISOString(),
        now,
      )
      .run();

    // Remove membership after the stream options were built, so the revalidation
    // inside the loop is what closes it.
    await env.DB.prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .bind(WS, revokedUser)
      .run();

    const response = createActivityStream(env.DB, {
      workspaceId: WS,
      chatId: aviChat,
      afterCursor: Number.MAX_SAFE_INTEGER,
      sessionToken: 'api_token_revoked',
      userId: revokedUser,
      pollIntervalMs: 5,
      maxStreamMs: 200,
      heartbeatMs: 50,
    });
    const body = await readAll(response);
    expect(body).toContain('event: membership_revoked');
  });

  it('activity stream never writes to sessions.last_seen_at during polling (D1 write limit regression)', async () => {
    const before = await env.DB.prepare(`SELECT last_seen_at FROM sessions WHERE id = 'sess_api_avi'`).first<{ last_seen_at: string }>();
    expect(before?.last_seen_at).toBeDefined();

    const response = createActivityStream(env.DB, {
      workspaceId: WS,
      chatId: aviChat,
      afterCursor: 0,
      sessionToken: 'api_token_avi',
      userId: AVI,
      pollIntervalMs: 5,
      maxStreamMs: 50,
      heartbeatMs: 20,
    });
    await readAll(response);

    const after = await env.DB.prepare(`SELECT last_seen_at FROM sessions WHERE id = 'sess_api_avi'`).first<{ last_seen_at: string }>();
    expect(after?.last_seen_at).toBe(before?.last_seen_at);
  });

  it('verifySession never writes: touches eliminated, verification is a pure read', async () => {
    const testToken = 'api_token_no_touch_test';
    const tokenHash = await sha256(testToken);
    const initialLastSeen = '2026-01-01T00:00:00.000Z';
    await env.DB.prepare(
      `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
       VALUES ('sess_no_touch_test', ?, ?, ?, ?, NULL, ?)`,
    )
      .bind(tokenHash, AVI, initialLastSeen, new Date(Date.now() + 3600 * 1000).toISOString(), initialLastSeen)
      .run();

    // Repeated verification — including back-to-back — never updates
    // last_seen_at: read paths (GET scope, SSE connect/poll/reconnect) cost
    // zero D1 writes. last_seen_at has no readers, so touches were removed
    // rather than debounced.
    for (let i = 0; i < 3; i += 1) {
      const verified = await verifySession(env.DB, testToken);
      expect(verified).not.toBeNull();
      expect(verified!.user.id).toBe(AVI);
    }
    await new Promise((r) => setTimeout(r, 10));
    const after = await env.DB.prepare(`SELECT last_seen_at FROM sessions WHERE id = 'sess_no_touch_test'`).first<{ last_seen_at: string }>();
    expect(after?.last_seen_at).toBe(initialLastSeen);
  });

  it('answers a control clarification and commits exactly the saved operation', async () => {
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI, title: 'Task chat' })).id;
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: WS,
      chatId,
      userId: AVI,
      clientMessageId: 'cm-control-clar',
      text: 'Remind Bistro to send the quote',
    });
    const inbound = await env.DB.prepare(
      `SELECT id FROM messages_in WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(chatId)
      .first<{ id: string }>();
    const now = new Date().toISOString();
    const pendingOperation = {
      version: 1,
      command_name: 'create_task',
      action_id: 'act-control-task',
      args: { title: 'Send the Bistro quote', entity_id: null, due: null },
      missing_fields: ['due'],
      source_revision: 0,
    };

    await env.DB.batch([
      env.DB.prepare(`UPDATE agent_runs SET status = 'waiting_for_input' WHERE id = ?`).bind(accepted.run_id),
      env.DB
        .prepare(
          `INSERT INTO pending_clarifications (id, workspace_id, chat_id, run_id, source_message_id, requester_user_id,
              question, intended_operation, missing_fields, operation_payload_json, source_revision, status, created_at, updated_at)
           VALUES ('clar_api_control', ?, ?, ?, ?, ?, 'When should this be due?', 'create_task', '["due"]', ?, 0, 'pending', ?, ?)`,
        )
        .bind(
          WS,
          chatId,
          accepted.run_id,
          inbound?.id ?? '',
          AVI,
          JSON.stringify(pendingOperation),
          now,
          now,
        ),
    ]);

    const reply = await callJson<{ status: string; clarification_id: string }>(
      `/api/workspaces/${WS}/clarifications/clar_api_control/reply`,
      {
        method: 'POST',
        cookie: aviCookie,
        headers: CSRF,
        body: JSON.stringify({
          text: 'No deadline for this one.',
          client_message_id: 'cm-control-answer',
          resolved_fields: { due: 'none' },
        }),
      },
    );
    expect(reply.status).toBe('resumed');

    const tasks = await env.DB.prepare(
      `SELECT id, title, due_kind FROM tasks WHERE workspace_id = ?`,
    )
      .bind(WS)
      .all<{ id: string; title: string; due_kind: string | null }>();
    expect(tasks.results).toHaveLength(1);
    expect(tasks.results[0]!.title).toBe('Send the Bistro quote');
    expect(tasks.results[0]!.due_kind).toBeNull();

    const clarification = await env.DB.prepare(
      `SELECT status FROM pending_clarifications WHERE id = 'clar_api_control'`,
    )
      .first<{ status: string }>();
    expect(clarification?.status).toBe('resolved');

    // Answering twice must not create a second task.
    const again = await call(`/api/workspaces/${WS}/clarifications/clar_api_control/reply`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({
        text: 'Still no deadline.',
        client_message_id: 'cm-control-answer-2',
        resolved_fields: { due: 'none' },
      }),
    });
    expect(again.status).toBe(409);

    const tasksAfter = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ?`)
      .bind(WS)
      .first<{ n: number }>();
    expect(Number(tasksAfter?.n)).toBe(1);
  });

  it('returns authoritative run state including steps, actions and pending clarification', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: WS,
      chatId: aviChat,
      userId: AVI,
      clientMessageId: 'cm-run-detail',
      text: 'What is happening?',
    });

    const detail = await callJson<RunDetailResponse>(
      `/api/workspaces/${WS}/runs/${accepted.run_id}`,
      { cookie: aviCookie },
    );
    expect(detail.run.id).toBe(accepted.run_id);
    expect(detail.status).toBe('queued');
    expect(Array.isArray(detail.steps)).toBe(true);
    expect(Array.isArray(detail.actions)).toBe(true);
    expect(detail.pending_clarification).toBeNull();
    // Activity is scoped to this run even though the chat has other rows.
    for (const activity of detail.activities) {
      expect(activity.run_id).toBe(accepted.run_id);
    }
  });

  it('retries a terminal failed run for its author, refuses strangers and unknown runs', async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO messages_in (id, workspace_id, chat_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
       VALUES ('min_retry_route', ?, ?, ?, 'web', 'ext_retry_route', 'fp_retry_route', 'failed', ?, ?)`,
    ).bind(WS, aviChat, AVI, now, now).run();
    await env.DB.prepare(
      `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, source_job_id, executor_kind, status, error_code, error_message, attempt_id, lease_fence, created_at, updated_at)
       VALUES ('run_retry_route', ?, ?, 'min_retry_route', NULL, 'agent', 'failed', 'provider_stream_error', 'Gone.', 'att_old', 1, ?, ?)`,
    ).bind(WS, aviChat, now, now).run();

    const retry = await call(`/api/workspaces/${WS}/runs/run_retry_route/retry`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({}),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ status: 'ok', retried: true, run_status: 'queued' });
    const row = await env.DB.prepare(`SELECT status, error_code FROM agent_runs WHERE id = 'run_retry_route'`)
      .first<{ status: string; error_code: string | null }>();
    expect(row?.status).toBe('queued');
    expect(row?.error_code).toBeNull();

    // Already queued: truthful no-op, still 200.
    const again = await callJson<{ status: string; retried: boolean; run_status: string }>(
      `/api/workspaces/${WS}/runs/run_retry_route/retry`,
      { method: 'POST', cookie: aviCookie, headers: CSRF, body: JSON.stringify({}) },
    );
    expect(again).toEqual({ status: 'ok', retried: false, run_status: 'queued' });

    // A teammate who is not the chat author is refused.
    const denied = await call(`/api/workspaces/${WS}/runs/run_retry_route/retry`, {
      method: 'POST',
      cookie: hunorCookie,
      headers: CSRF,
      body: JSON.stringify({}),
    });
    expect(denied.status).toBe(403);

    // Unknown runs 404, even for members.
    const missing = await call(`/api/workspaces/${WS}/runs/run_missing/retry`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(404);
  });

  it('exports member-readable business data with secrets excluded', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: WS,
      chatId: aviChat,
      userId: AVI,
      clientMessageId: 'cm-export-1',
      text: 'Exportable field note',
    });
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO provider_credentials (workspace_id, provider, encrypted_key, key_nonce, key_version, status, created_at, updated_at)
       VALUES (?, 'gemini', 'ENCRYPTED-SECRET-MATERIAL', 'nonce-1', 1, 'available', ?, ?)`,
    ).bind(WS, now, now).run();
    try {
      const res = await call(`/api/workspaces/${WS}/export`, { cookie: aviCookie });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      expect(res.headers.get('Content-Disposition')).toContain('attachment');
      const doc = (await res.json()) as Record<string, unknown>;
      expect(doc['version']).toBe(1);
      expect((doc['workspace'] as Record<string, unknown>)['id']).toBe(WS);

      const messages = doc['chat_messages'] as Array<Record<string, unknown>>;
      expect(messages.some((m) => m['content_text'] === 'Exportable field note')).toBe(true);
      const inbound = doc['messages_in'] as Array<Record<string, unknown>>;
      expect(inbound.some((m) => String(m['chat_id']) === aviChat)).toBe(true);
      expect(accepted.run_id).toBeTruthy();

      // Secrets never enter the document: no credential rows, sessions,
      // invites, bindings, or key material under any key.
      const serialized = JSON.stringify(doc);
      expect(serialized).not.toContain('ENCRYPTED-SECRET-MATERIAL');
      expect(serialized).not.toContain('token_hash');
      expect(doc).not.toHaveProperty('provider_credentials');
      expect(doc).not.toHaveProperty('sessions');
      expect(doc).not.toHaveProperty('invites');
      expect(doc).not.toHaveProperty('telegram_users');
      // Membership is member-visible and needed to interpret authorship.
      const memberships = doc['memberships'] as Array<Record<string, unknown>>;
      expect(memberships.some((m) => m['user_id'] === AVI)).toBe(true);
      const users = doc['users'] as Array<Record<string, unknown>>;
      expect(users.every((u) => !('email' in u))).toBe(true);
    } finally {
      // The credential seed must not leak into sibling tests: model
      // availability assertions depend on a keyless workspace.
      await env.DB.prepare(
        `DELETE FROM provider_credentials WHERE workspace_id = ? AND provider = 'gemini'`,
      ).bind(WS).run();
    }
  });

  it('round-trips ledger events through a rebuild identically', async () => {
    await commitEntity('Export Bakery', aviChat);
    const res = await call(`/api/workspaces/${WS}/export`, { cookie: aviCookie });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      events: Array<{ id: string; kind: string }>;
      tasks: unknown[];
      entities: Array<{ id: string; name: string }>;
    };
    expect(doc.entities.some((e) => e.name === 'Export Bakery')).toBe(true);
    const { getWorkspaceEvents, rebuildProjections } = await import('@otis/ledger');
    const live = await getWorkspaceEvents(env.DB, WS);
    expect(live.length).toBe(doc.events.length);
    const rebuilt = rebuildProjections(live);
    expect(rebuilt.tasks.size).toBe((doc.tasks as unknown[]).length);
  });

  it('denies outsiders and unknown workspaces without leaking existence', async () => {
    const outsider = await call(`/api/workspaces/${WS}/export`, { cookie: outsiderCookie });
    expect(outsider.status).toBe(404);
    const missing = await call(`/api/workspaces/ws_export_missing/export`, { cookie: aviCookie });
    expect(missing.status).toBe(404);
  });

  it('batches run details in request order, omitting unknown ids', async () => {    const first = await acceptWebMessage(env.DB, {
      workspaceId: WS,
      chatId: aviChat,
      userId: AVI,
      clientMessageId: 'cm-run-batch-1',
      text: 'First batched question?',
    });
    const second = await acceptWebMessage(env.DB, {
      workspaceId: WS,
      chatId: aviChat,
      userId: AVI,
      clientMessageId: 'cm-run-batch-2',
      text: 'Second batched question?',
    });

    const batch = await callJson<RunBatchResponse>(
      `/api/workspaces/${WS}/runs?ids=${second.run_id},${first.run_id},run_missing`,
      { cookie: aviCookie },
    );
    expect(batch.runs.map((run) => run.run.id)).toEqual([second.run_id, first.run_id]);
    for (const run of batch.runs) {
      expect(Array.isArray(run.steps)).toBe(true);
      expect(Array.isArray(run.actions)).toBe(true);
      for (const activity of run.activities) {
        expect(activity.run_id).toBe(run.run.id);
      }
    }

    const empty = await callJson<RunBatchResponse>(
      `/api/workspaces/${WS}/runs?ids=`,
      { cookie: aviCookie },
    );
    expect(empty.runs).toEqual([]);

    const outsider = await call(
      `/api/workspaces/${WS}/runs?ids=${first.run_id}`,
      { cookie: outsiderCookie },
    );
    expect([401, 403, 404]).toContain(outsider.status);
  });

  it('attributes receipts across both linkages in timestamp order', async () => {
    const first = await acceptWebMessage(env.DB, {
      workspaceId: WS,
      chatId: aviChat,
      userId: AVI,
      clientMessageId: 'cm-run-link-1',
      text: 'First linked question?',
    });
    const second = await acceptWebMessage(env.DB, {
      workspaceId: WS,
      chatId: aviChat,
      userId: AVI,
      clientMessageId: 'cm-run-link-2',
      text: 'Second linked question?',
    });
    const inbound = (
      await env.DB
        .prepare(`SELECT id FROM messages_in WHERE channel = 'web' AND external_id IN ('cm-run-link-1', 'cm-run-link-2') ORDER BY external_id ASC`)
        .all<{ id: string }>()
    ).results || [];
    expect(inbound).toHaveLength(2);
    const sourceOfSecond = inbound[1]!.id;
    // A: direct run link. B: source-message link with an earlier timestamp,
    // exercising the cross-query sort. C: both linkages across the two runs.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO action_receipts (id, workspace_id, action_id, payload_hash, command_name, result_status, result_json, actor_kind, source_message_id, run_id, committed_revision, created_at)
         VALUES (?, ?, ?, 'test', 'create_task', 'applied', '{}', 'member', NULL, ?, 1, '2026-10-07T00:00:02.000Z')`,
      ).bind('row_batch_a', WS, 'act_batch_a', first.run_id),
      env.DB.prepare(
        `INSERT INTO action_receipts (id, workspace_id, action_id, payload_hash, command_name, result_status, result_json, actor_kind, source_message_id, run_id, committed_revision, created_at)
         VALUES (?, ?, ?, 'test', 'create_task', 'applied', '{}', 'member', ?, NULL, 1, '2026-10-07T00:00:01.000Z')`,
      ).bind('row_batch_b', WS, 'act_batch_b', sourceOfSecond),
      env.DB.prepare(
        `INSERT INTO action_receipts (id, workspace_id, action_id, payload_hash, command_name, result_status, result_json, actor_kind, source_message_id, run_id, committed_revision, created_at)
         VALUES (?, ?, ?, 'test', 'create_task', 'applied', '{}', 'member', ?, ?, 1, '2026-10-07T00:00:03.000Z')`,
      ).bind('row_batch_c', WS, 'act_batch_c', sourceOfSecond, first.run_id),
    ]);

    const batch = await callJson<RunBatchResponse>(
      `/api/workspaces/${WS}/runs?ids=${first.run_id},${second.run_id}`,
      { cookie: aviCookie },
    );
    const actionsOf = (runId: string) =>
      batch.runs.find((run) => run.run.id === runId)!.actions.map((action) => action.action_id);
    expect(actionsOf(first.run_id)).toEqual(['act_batch_a', 'act_batch_c']);
    // The source-linked receipt sorts first by timestamp, and the
    // cross-linked receipt appears here too, as in the single-run view.
    expect(actionsOf(second.run_id)).toEqual(['act_batch_b', 'act_batch_c']);
  });

  it('caps batched activity at the most recent 200 rows per run', async () => {
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: WS,
      chatId: aviChat,
      userId: AVI,
      clientMessageId: 'cm-run-cap-1',
      text: 'A very chatty run?',
    });
    const now = new Date().toISOString();
    await env.DB.batch(
      Array.from({ length: 205 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, 'text_chunk', '{}', ?)`,
        ).bind(`act_cap_${index + 1}`, WS, aviChat, accepted.run_id, 1000 + index + 1, now),
      ),
    );

    const batch = await callJson<RunBatchResponse>(
      `/api/workspaces/${WS}/runs?ids=${accepted.run_id}`,
      { cookie: aviCookie },
    );
    const activities = batch.runs[0]!.activities;
    expect(activities).toHaveLength(200);
    expect(activities[0]!.cursor).toBe(1006);
    expect(activities[199]!.cursor).toBe(1205);
  });

  it('reports a pending clarification and refuses an answer from another member', async () => {
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI, title: 'Clar chat' })).id;
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: WS,
      chatId,
      userId: AVI,
      clientMessageId: 'cm-clar-1',
      text: 'Create the follow-up task',
    });
    const inbound = await env.DB.prepare(`SELECT id FROM messages_in WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(chatId)
      .first<{ id: string }>();
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`UPDATE agent_runs SET status = 'waiting_for_input' WHERE id = ?`).bind(accepted.run_id),
      env.DB.prepare(
        `INSERT INTO pending_clarifications (id, workspace_id, chat_id, run_id, source_message_id, requester_user_id,
            question, intended_operation, missing_fields, source_revision, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'When is it due?', 'create_task', '["due"]', 0, 'pending', ?, ?)`,
      )
        .bind(
          'clar_api_1',
          WS,
          chatId,
          accepted.run_id,
          inbound?.id ?? '',
          AVI,
          now,
          now,
        ),
    ]);

    const listed = await callJson<ClarificationListResponse>(
      `/api/workspaces/${WS}/chats/${chatId}/clarifications`,
      { cookie: aviCookie },
    );
    expect(listed.clarifications).toHaveLength(1);
    expect(listed.clarifications[0]!.answerable_by_caller).toBe(true);
    expect(listed.clarifications[0]!.missing_fields).toEqual(['due']);

    const runDetail = await callJson<RunDetailResponse>(`/api/workspaces/${WS}/runs/${accepted.run_id}`, {
      cookie: aviCookie,
    });
    expect(runDetail.status).toBe('waiting_for_input');
    expect(runDetail.pending_clarification?.question).toBe('When is it due?');

    const asTeammate = await call(
      `/api/workspaces/${WS}/clarifications/clar_api_1/reply`,
      {
        method: 'POST',
        cookie: hunorCookie,
        headers: CSRF,
        body: JSON.stringify({ text: 'Friday', client_message_id: 'cm-hunor-answer' }),
      },
    );
    expect(asTeammate.status).toBe(403);

    const stillPending = await env.DB.prepare(
      `SELECT status FROM pending_clarifications WHERE id = 'clar_api_1'`,
    )
      .first<{ status: string }>();
    expect(stillPending?.status).toBe('pending');
  });

  it('refuses to answer an already-resolved clarification', async () => {
    await env.DB.prepare(`UPDATE pending_clarifications SET status = 'resolved' WHERE id = 'clar_api_1'`).run();
    const res = await call(`/api/workspaces/${WS}/clarifications/clar_api_1/reply`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({ text: 'Friday', client_message_id: 'cm-late-answer' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('Chat API: action detail and undo', () => {
  it('previews and commits undo, then reports the action as no longer undoable', async () => {
    const actionId = await commitEntity('Bistro', aviChat);

    const detail = await callJson<ActionDetailResponse>(
      `/api/workspaces/${WS}/actions/${actionId}`,
      { cookie: aviCookie },
    );
    expect(detail.action.command_name).toBe('create_entity');
    expect(detail.action.events).toHaveLength(1);
    expect(detail.action.undo.available).toBe(true);
    expect(detail.action.source?.text_preview).toContain('Create Bistro');

    const preview = await callJson<UndoPreviewResponse>(
      `/api/workspaces/${WS}/actions/${actionId}/undo-preview`,
      { method: 'POST', cookie: aviCookie, headers: CSRF, body: JSON.stringify({ mode: 'from_here' }) },
    );
    expect(preview.preview.target_action_id).toBe(actionId);
    expect(preview.preview.selected_action_ids).toContain(actionId);
    expect(preview.preview.affected_entities.some((entity) => entity.name === 'Bistro')).toBe(true);

    const entityBefore = await env.DB.prepare(`SELECT COUNT(*) AS n FROM entities WHERE workspace_id = ? AND name = 'Bistro'`)
      .bind(WS)
      .first<{ n: number }>();
    expect(Number(entityBefore?.n)).toBe(1);

    const commit = await callJson<UndoCommitResponse>(
      `/api/workspaces/${WS}/actions/${actionId}/undo?chat_id=${aviChat}`,
      {
        method: 'POST',
        cookie: aviCookie,
        headers: CSRF,
        body: JSON.stringify({
          mode: 'from_here',
          client_operation_id: 'undo-op-bistro',
          expected_revision: preview.preview.expected_revision,
        }),
      },
    );
    expect(commit.status).toBe('applied');
    expect(commit.revert_event_ids.length).toBeGreaterThan(0);

    const entityAfter = await env.DB.prepare(`SELECT COUNT(*) AS n FROM entities WHERE workspace_id = ? AND name = 'Bistro'`)
      .bind(WS)
      .first<{ n: number }>();
    expect(Number(entityAfter?.n)).toBe(0);

    const afterDetail = await callJson<ActionDetailResponse>(
      `/api/workspaces/${WS}/actions/${actionId}`,
      { cookie: aviCookie },
    );
    expect(afterDetail.action.undo.available).toBe(false);
    expect(afterDetail.action.undo.reverted_event_ids).toHaveLength(1);

    // The revert is visible as public activity in the requester's chat.
    const activity = await callJson<ActivityPageResponse>(
      `/api/workspaces/${WS}/chats/${aviChat}/activity?after=0`,
      { cookie: aviCookie },
    );
    expect(activity.activities.some((item) => item.type === 'action_reverted')).toBe(true);
  });

  it('is idempotent for a retried undo request and never reverts twice', async () => {
    const actionId = await commitEntity('Cafe Latte', aviChat);
    const first = await callJson<UndoCommitResponse>(
      `/api/workspaces/${WS}/actions/${actionId}/undo`,
      {
        method: 'POST',
        cookie: aviCookie,
        headers: CSRF,
        body: JSON.stringify({ mode: 'single', client_operation_id: 'undo-op-retry', expected_revision: (await getWorkspaceRevision(env.DB, WS))!.business_revision }),
      },
    );
    if (first.status !== 'applied') {
      throw new Error(`undo body: ${JSON.stringify(first)}`);
    }

    const retryRes = await call(`/api/workspaces/${WS}/actions/${actionId}/undo`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({ mode: 'single', client_operation_id: 'undo-op-retry', expected_revision: (await getWorkspaceRevision(env.DB, WS))!.business_revision }),
    });
    const retryText = await retryRes.text();
    const retry = JSON.parse(retryText) as UndoCommitResponse;
    if (retry.status !== 'already_applied') {
      // Bounded diagnostic retention for the intermittent root-only failure:
      // keep the exact synthetic HTTP status and error code, never just an
      // undefined status from a 4xx error body.
      const errorCode = (JSON.parse(retryText) as { error?: { code?: string } }).error?.code ?? 'none';
      throw new Error(`undo retry HTTP ${retryRes.status} code ${errorCode} body ${retryText.slice(0, 300)}`);
    }
    expect(retry.revert_event_ids).toEqual(first.revert_event_ids);

    const revertCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND kind = 'revert'`,
    )
      .bind(WS)
      .first<{ n: number }>();
    // Exactly two undo commits happened in this workspace: Bistro and Cafe Latte.
    expect(Number(revertCount?.n)).toBe(2);
  });

  it('replays an omitted-chat undo in its recorded chat even when another own chat is more recent', async () => {
    const actionId = await commitEntity('Implicit Chat Cafe', aviChat);
    // The first undo omits chat_id and resolves the most recent own chat.
    const settled = new Date().toISOString();
    await env.DB.prepare(`UPDATE chats SET last_activity_at = ?, updated_at = ? WHERE id = ?`).bind(settled, settled, aviChat).run();
    const firstRes = await call(`/api/workspaces/${WS}/actions/${actionId}/undo`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({
        mode: 'single',
        client_operation_id: 'undo-op-implicit-chat',
        expected_revision: (await getWorkspaceRevision(env.DB, WS))!.business_revision,
      }),
    });
    const firstText = await firstRes.text();
    const first = JSON.parse(firstText) as UndoCommitResponse;
    if (first.status !== 'applied') {
      throw new Error(`undo first HTTP ${firstRes.status} body ${firstText.slice(0, 300)}`);
    }
    expect(first.revert_event_ids.length).toBeGreaterThan(0);

    // Another own chat becomes strictly more recent after the first undo.
    const other = await createChat(env.DB, { workspaceId: WS, authorUserId: AVI, title: 'More recent chat' });
    const future = new Date(Date.now() + 60_000).toISOString();
    await env.DB.prepare(`UPDATE chats SET last_activity_at = ?, updated_at = ? WHERE id = ?`).bind(future, future, other.id).run();

    // The exact same retry must replay the recorded receipt in the recorded
    // chat — never resolve the newer chat, 409, or revert a second time.
    const retryRes = await call(`/api/workspaces/${WS}/actions/${actionId}/undo`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({
        mode: 'single',
        client_operation_id: 'undo-op-implicit-chat',
        expected_revision: (await getWorkspaceRevision(env.DB, WS))!.business_revision,
      }),
    });
    const retryText = await retryRes.text();
    const retry = JSON.parse(retryText) as UndoCommitResponse;
    if (retry.status !== 'already_applied') {
      // Bounded synthetic HTTP status and error code for this exact retry.
      const errorCode = (JSON.parse(retryText) as { error?: { code?: string } }).error?.code ?? 'none';
      throw new Error(`undo retry HTTP ${retryRes.status} code ${errorCode} body ${retryText.slice(0, 300)}`);
    }
    expect(retry.revert_event_ids).toEqual(first.revert_event_ids);

    // Exactly one revert event for this operation and one reverted entity.
    const reverts = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND kind = 'revert' AND action_id = ?`)
      .bind(WS, `undo_${WS}_undo-op-implicit-chat`)
      .first<{ n: number }>();
    expect(Number(reverts?.n)).toBe(1);
    const entity = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM entities WHERE workspace_id = ? AND name = 'Implicit Chat Cafe'`)
      .bind(WS)
      .first<{ n: number }>();
    expect(Number(entity?.n)).toBe(0);
  });

  it('attributes a teammate-requested undo to the teammate chat', async () => {
    const actionId = await commitEntity('Thai Garden', aviChat);
    const commit = await callJson<UndoCommitResponse>(
      `/api/workspaces/${WS}/actions/${actionId}/undo?chat_id=${hunorChat}`,
      {
        method: 'POST',
        cookie: hunorCookie,
        headers: CSRF,
        body: JSON.stringify({ mode: 'single', client_operation_id: 'undo-op-hunor', expected_revision: (await getWorkspaceRevision(env.DB, WS))!.business_revision }),
      },
    );
    expect(commit.status).toBe('applied');

    const event = await env.DB.prepare(
      `SELECT actor_user_id FROM events WHERE workspace_id = ? AND kind = 'revert' ORDER BY sequence DESC LIMIT 1`,
    )
      .bind(WS)
      .first<{ actor_user_id: string }>();
    expect(event?.actor_user_id).toBe(HUNOR);

    const hunorActivity = await callJson<ActivityPageResponse>(
      `/api/workspaces/${WS}/chats/${hunorChat}/activity?after=0`,
      { cookie: hunorCookie },
    );
    const revertActivity = hunorActivity.activities.find((item) => item.type === 'action_reverted');
    expect(revertActivity).toBeDefined();
    expect((revertActivity!.payload as { requested_by_user_id: string }).requested_by_user_id).toBe(HUNOR);
  });

  it('refuses a cross-workspace action id and a cross-origin undo', async () => {
    const actionId = await commitEntity('Panzeria', aviChat);

    const crossWorkspace = await call(`/api/workspaces/ws-api-other/actions/${actionId}`, {
      cookie: outsiderCookie,
    });
    expect(crossWorkspace.status).toBe(404);

    const noCsrf = await call(`/api/workspaces/${WS}/actions/${actionId}/undo`, {
      method: 'POST',
      cookie: aviCookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'single', client_operation_id: 'undo-op-nocsrf' }),
    });
    expect(noCsrf.status).toBe(403);

    const stillPresent = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM entities WHERE workspace_id = ? AND name = 'Panzeria'`,
    )
      .bind(WS)
      .first<{ n: number }>();
    expect(Number(stillPresent?.n)).toBe(1);
  });

  it('rejects an unsupported undo mode without touching the ledger', async () => {
    const actionId = await commitEntity('Crama', aviChat);
    const res = await call(`/api/workspaces/${WS}/actions/${actionId}/undo`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({ mode: 'everything', client_operation_id: 'undo-op-bad-mode' }),
    });
    expect(res.status).toBe(422);

    const events = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND action_id = ?`,
    )
      .bind(WS, actionId)
      .first<{ n: number }>();
    expect(Number(events?.n)).toBe(1);
  });
});

describe('Chat API: command registry and models', () => {
  it('serves the web registry without the telegram-only command', async () => {
    const body = await callJson<{ surface: string; commands: { name: string }[] }>('/api/commands?surface=web');
    expect(body.surface).toBe('web');
    const names = body.commands.map((command) => command.name);
    expect(names).toContain('model');
    expect(names).not.toContain('start');
    expect(names).toContain('sheet');

    const telegram = await callJson<{ commands: { name: string }[] }>('/api/commands?surface=telegram');
    expect(telegram.commands.map((command) => command.name)).toContain('start');
  });

  it('lists only registry models and marks unavailable ones honestly', async () => {
    const body = await callJson<ModelListResponse>(`/api/workspaces/${WS}/models?chat_id=${aviChat}`, {
      cookie: aviCookie,
    });
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models.every((model) => Boolean(model.command_key && model.display_name))).toBe(true);
    // No credential is configured in this fixture, so nothing claims availability.
    expect(body.models.every((model) => model.available === false)).toBe(true);
    expect(body.unavailable_reason).toBeTruthy();
  });

  it('answers /help deterministically and records the attributed turn', async () => {
    const res = await call(`/api/workspaces/${WS}/chats/${aviChat}/commands`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({ text: '/help', client_message_id: 'cm-help-1' }),
    });
    if (res.status !== 200) {
      throw new Error(`command route failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { reply: string; message_id: string };
    expect(body.reply).toContain('/model');
    expect(body.reply).toContain('/today');

    const stored = await env.DB.prepare(`SELECT content_text FROM chat_messages WHERE id = ?`)
      .bind(body.message_id)
      .first<{ content_text: string }>();
    expect(stored?.content_text).toContain('/help');
  });

  it('rejects ordinary prose sent through the command shortcut', async () => {
    const res = await call(`/api/workspaces/${WS}/chats/${aviChat}/commands`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({ text: 'Restaurant 2 wants the website', client_message_id: 'cm-prose' }),
    });
    expect(res.status).toBe(422);
  });

  it('refuses a command from a member who does not author that chat', async () => {
    const res = await call(`/api/workspaces/${WS}/chats/${aviChat}/commands`, {
      method: 'POST',
      cookie: hunorCookie,
      headers: CSRF,
      body: JSON.stringify({ text: '/help', client_message_id: 'cm-help-hunor' }),
    });
    expect(res.status).toBe(403);
  });

  it('answers /sheet with a scoped spreadsheet download link', async () => {
    const res = await call(`/api/workspaces/${WS}/chats/${aviChat}/commands`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({ text: '/sheet', client_message_id: 'cm-sheet-1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: string };
    expect(body.reply).toContain(`/api/workspaces/${WS}/export?format=xlsx`);
    expect(body.reply).toContain('Download spreadsheet');
  });

  it('rejects unknown export formats instead of guessing', async () => {
    const res = await call(`/api/workspaces/${WS}/export?format=pdf`, { cookie: aviCookie });
    expect(res.status).toBe(422);
  });

  it('serves the spreadsheet snapshot as a valid workbook download', async () => {
    const res = await call(`/api/workspaces/${WS}/export?format=xlsx`, { cookie: aviCookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('spreadsheetml.sheet');
    expect(res.headers.get('Content-Disposition')).toContain('.xlsx');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    // Workbook central directory names every sheet part.
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    expect(text).toContain('xl/workbook.xml');
    expect(text).toContain('xl/worksheets/sheet1.xml');
  });

  it('answers /sheet on Telegram with the web path instead of a dead link', async () => {
    const { executeCommand } = await import('../src/routes/commands.js');
    const result = await executeCommand(
      { db: env.DB, workspaceId: WS, userId: AVI, surface: 'telegram' },
      null,
      '/sheet',
    );
    expect(result.kind).toBe('reply');
    if (result.kind !== 'reply') throw new Error('expected reply');
    expect(result.text).toContain('Settings');
    expect(result.text).not.toContain('/api/workspaces');
  });
});

describe('007 review regressions: normal composer route', () => {
  const post = (chatId: string, body: unknown, cookie = aviCookie) => call(`/api/workspaces/${WS}/chats/${chatId}/messages`, { method: 'POST', cookie, headers: CSRF, body: JSON.stringify(body) });

  it('validates runtime bodies and cursors instead of returning 500 or broadening reads', async () => {
    for (const body of [null, [], { text: 'Hello', client_message_id: 4 }, { text: 'Hi', client_message_id: 'x', media_id: 'bogus' }]) expect((await post(aviChat, body)).status).toBe(422);
    for (const suffix of ['?cursor=not-a-valid-cursor', '?limit=2x', '?filter=anything']) expect((await call(`/api/workspaces/${WS}/chats${suffix}`, { cookie: aviCookie })).status).toBe(422);
    for (const suffix of ['?before_sequence=2x', '?limit=1.5']) expect((await call(`/api/workspaces/${WS}/chats/${aviChat}/messages${suffix}`, { cookie: aviCookie })).status).toBe(422);
    expect((await call(`/api/workspaces/${WS}/chats`, { method: 'POST', cookie: aviCookie, headers: CSRF, body: 'null' })).status).toBe(422);
  });

  it('binds idempotent chat creation to its author and input', async () => {
    const body = { client_chat_id: 'chat-create-regression', title: 'Dense conversation' };
    const create = (payload: unknown, cookie: string) => call(`/api/workspaces/${WS}/chats`, { method: 'POST', cookie, headers: CSRF, body: JSON.stringify(payload) });
    expect((await create(body, aviCookie)).status).toBe(201);
    expect((await create(body, aviCookie)).status).toBe(201);
    expect((await create(body, hunorCookie)).status).toBe(409);
    expect((await create({ ...body, title: 'Different' }, aviCookie)).status).toBe(409);
  });

  it('executes a command through normal POST as one durable command turn with no agent outbox', async () => {
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;
    const body = { text: '/help', client_message_id: 'normal-help-regression' };
    const first = await post(chatId, body); expect(first.status).toBe(202);
    const accepted = await first.json() as { run_id: string; message_id: string };
    const retry = await post(chatId, body); expect(retry.status).toBe(202); expect(await retry.json()).toMatchObject(accepted);
    expect((await post(chatId, { ...body, text: '/today' })).status).toBe(409);
    const run = await env.DB.prepare(`SELECT executor_kind, status FROM agent_runs WHERE id = ?`).bind(accepted.run_id).first();
    expect(run).toMatchObject({ executor_kind: 'command', status: 'succeeded' });
    expect(await env.DB.prepare(`SELECT id FROM outbox WHERE json_extract(payload_json, '$.run_id') = ?`).bind(accepted.run_id).first()).toBeNull();
    const messages = await callJson<MessageListResponse>(`/api/workspaces/${WS}/chats/${chatId}/messages`, { cookie: aviCookie });
    expect(messages.messages.map(message => message.author_kind)).toEqual(['member', 'system']);
  });

  it('steers the active run through normal POST and replays that same receipt after completion', async () => {
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;
    const original = await acceptWebMessage(env.DB, { workspaceId: WS, chatId, userId: AVI, clientMessageId: 'normal-steer-original', text: 'Prepare the offer' });
    const body = { text: 'Keep it under 150 words.', client_message_id: 'normal-steer-context' };
    const res = await post(chatId, body); expect(res.status).toBe(202);
    const accepted = await res.json(); expect(accepted).toMatchObject({ run_id: original.run_id, mode: 'steer' });
    await env.DB.prepare(`UPDATE agent_runs SET status = 'succeeded' WHERE id = ?`).bind(original.run_id).run();
    expect(await (await post(chatId, body)).json()).toEqual(accepted);
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE chat_id = ?`).bind(chatId).first<{ n: number }>(); expect(count?.n).toBe(1);
    expect((await post(chatId, { text: 'Inject', client_message_id: 'normal-steer-teammate' }, hunorCookie)).status).toBe(403);
  });

  it('answers a targeted saved question with text only, without confusing an unrelated next message', async () => {
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;
    const accepted = await acceptWebMessage(env.DB, { workspaceId: WS, chatId, userId: AVI, clientMessageId: 'normal-question-original', text: 'Create a reminder' });
    const source = await env.DB.prepare(`SELECT id FROM messages_in WHERE external_id = 'normal-question-original'`).first<{ id: string }>();
    const now = new Date().toISOString(); const revision = (await getWorkspaceRevision(env.DB, WS))!.business_revision;
    await env.DB.batch([
      env.DB.prepare(`UPDATE agent_runs SET status = 'waiting_for_input' WHERE id = ?`).bind(accepted.run_id),
      env.DB.prepare(`INSERT INTO pending_clarifications (id, workspace_id, chat_id, run_id, source_message_id, requester_user_id, question, intended_operation, missing_fields, operation_payload_json, source_revision, status, created_at, updated_at) VALUES ('normal-question-regression', ?, ?, ?, ?, ?, 'When is it due?', 'create_task', '["due"]', ?, ?, 'pending', ?, ?)`)
        .bind(WS, chatId, accepted.run_id, source!.id, AVI, JSON.stringify({ version: 1, command_name: 'create_task', action_id: 'normal-question-task', args: { title: 'Text answer reminder', entity_id: null, due: null }, missing_fields: ['due'], source_revision: revision }), revision, now, now),
    ]);
    expect((await post(chatId, { text: 'Read my notes instead.', client_message_id: 'normal-question-unrelated' })).status).toBe(202);
    expect(await env.DB.prepare(`SELECT status FROM pending_clarifications WHERE id = 'normal-question-regression'`).first()).toMatchObject({ status: 'pending' });
    const body = { text: 'No deadline needed', client_message_id: 'normal-question-answer', clarification_id: 'normal-question-regression' };
    expect((await post(aviChat, body)).status).toBe(404);
    const answer = await post(chatId, body); expect(answer.status).toBe(202); expect(await answer.json()).toMatchObject({ run_id: accepted.run_id, status: 'resumed' });
    expect((await post(chatId, body)).status).toBe(202);
    const tasks = await env.DB.prepare(`SELECT due_kind FROM tasks WHERE workspace_id = ? AND title = 'Text answer reminder'`).bind(WS).all(); expect(tasks.results).toEqual([{ due_kind: null }]);
  });

  it('executes slash undo once and rejects operation reuse with a different mode', async () => {
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;
    const actionId = await commitEntity('Undocomposerregression', chatId);
    const body = { text: `/undo ${actionId}`, client_message_id: 'normal-undo-regression' };
    const first = await post(chatId, body); expect(first.status).toBe(202);
    const receipt = await first.json(); expect(receipt).toMatchObject({ status: 'accepted' });
    expect(await (await post(chatId, body)).json()).toMatchObject(receipt);
    expect((await post(chatId, { ...body, text: `/undo ${actionId} single` })).status).toBe(409);
    const turns = await env.DB.prepare(`SELECT author_kind FROM chat_messages WHERE chat_id = ? AND run_id = ? ORDER BY sequence`).bind(chatId, (receipt as { run_id: string }).run_id).all(); expect(turns.results).toEqual([{ author_kind: 'member' }, { author_kind: 'system' }]);
    expect(await env.DB.prepare(`SELECT id FROM entities WHERE name = 'Undocomposerregression' AND workspace_id = ?`).bind(WS).first()).toBeNull();
  });
});


describe('007 deterministic command behavior', () => {
  const send = (chatId: string, text: string, id: string) => call(`/api/workspaces/${WS}/chats/${chatId}/messages`, { method: 'POST', cookie: aviCookie, headers: CSRF, body: JSON.stringify({ text, client_message_id: id }) });
  it('changes only the selected chat, clears the override, and pins the model at acceptance', async () => {
    const now = new Date().toISOString();
    const model = PRODUCTION_REGISTRY.entries.find(entry => entry.provider === 'opencode_go' && entry.lifecycle === 'active')!;
    await env.DB.prepare(`INSERT INTO provider_credentials (workspace_id, provider, encrypted_key, key_nonce, status, created_at, updated_at) VALUES (?, 'opencode_go', 'synthetic-test-only', 'synthetic', 'available', ?, ?) ON CONFLICT(workspace_id, provider) DO UPDATE SET status = 'available'`).bind(WS, now, now).run();
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;
    expect((await send(chatId, `/model ${model.commandKey}`, 'model-configured-regression')).status).toBe(202);
    expect(await env.DB.prepare(`SELECT model_override FROM chats WHERE id = ?`).bind(chatId).first()).toEqual({ model_override: model.commandKey });
    expect(await env.DB.prepare(`SELECT model_override FROM chats WHERE id = ?`).bind(hunorChat).first()).toEqual({ model_override: null });
    const accepted = await acceptWebMessage(env.DB, { workspaceId: WS, chatId, userId: AVI, clientMessageId: 'model-pinned-regression', text: 'Read the notes' });
    expect((await send(chatId, '/model default', 'model-default-regression')).status).toBe(202);
    expect(await env.DB.prepare(`SELECT model_key FROM agent_runs WHERE id = ?`).bind(accepted.run_id).first()).toEqual({ model_key: model.commandKey });
    expect(await env.DB.prepare(`SELECT model_override FROM chats WHERE id = ?`).bind(chatId).first()).toEqual({ model_override: null });
    const unavailable = await send(chatId, '/model unregistered-key', 'model-unavailable-regression'); expect(unavailable.status).toBe(202); expect(await unavailable.json()).toMatchObject({ reply: expect.stringContaining('unavailable') });
    expect(await env.DB.prepare(`SELECT model_override FROM chats WHERE id = ?`).bind(chatId).first()).toEqual({ model_override: null });
  });

  it('persists workspace selection on the origin command without moving history or Telegram state', async () => {
    const now = new Date().toISOString(); const target = 'ws-selection-regression';
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?, 'Studio two', ?, ?, ?)`).bind(target, AVI, now, now),
      env.DB.prepare(`INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)`).bind(target, AVI, now, now, now),
    ]);
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;
    const first = await send(chatId, '/workspace Studio two', 'workspace-selection-regression'); expect(first.status).toBe(202);
    const body = await first.json() as { run_id: string; selected_workspace_id: string }; expect(body.selected_workspace_id).toBe(target);
    const saved = await env.DB.prepare(`SELECT payload_json FROM run_activity WHERE run_id = ? AND type = 'answer_saved'`).bind(body.run_id).first<{ payload_json: string }>(); expect(JSON.parse(saved!.payload_json).selected_workspace_id).toBe(target);
    expect(await env.DB.prepare(`SELECT workspace_id FROM chats WHERE id = ?`).bind(chatId).first()).toEqual({ workspace_id: WS });
    expect(await (await send(chatId, '/workspace Studio two', 'workspace-selection-regression')).json()).toMatchObject(body);
  });

  it('shows due work while scheduled briefs remain disabled and without creating a notification', async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO member_settings (workspace_id, user_id, brief_timezone, created_at, updated_at) VALUES (?, ?, 'Europe/Bucharest', ?, ?) ON CONFLICT(workspace_id, user_id) DO UPDATE SET brief_timezone = 'Europe/Bucharest'`).bind(WS, AVI, now, now).run();
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;
    const accepted = await acceptWebMessage(env.DB, { workspaceId: WS, chatId, userId: AVI, clientMessageId: 'today-source-regression', text: 'Remind me to send the offer yesterday' });
    const source = await env.DB.prepare(`SELECT id FROM messages_in WHERE external_id = 'today-source-regression'`).first<{ id: string }>();
    const revision = (await getWorkspaceRevision(env.DB, WS))!.business_revision;
    const result = await executeLedgerCommand(env.DB, { workspace_id: WS, action_id: 'today-task-regression', expected_business_revision: revision, actor: { kind: 'member', user_id: AVI }, membership_revision: 1, request_id: 'today-test', source_message_id: source!.id, source_channel: 'web', chat_id: chatId }, 'create_task', { title: 'Schedule-free due offer', due: { kind: 'date', local_date: '2026-01-01', timezone: 'Europe/Bucharest' } }, handleCreateTask, undefined, { deferRunTransition: true });
    expect(result.status).toBe('applied');
    const response = await send(chatId, '/today', 'today-command-regression'); expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ reply: expect.stringContaining('Schedule-free due offer') });
    expect(await env.DB.prepare(`SELECT brief_enabled, brief_local_time FROM member_settings WHERE workspace_id = ? AND user_id = ?`).bind(WS, AVI).first()).toEqual({ brief_enabled: 0, brief_local_time: null });
    const run = await env.DB.prepare(`SELECT run_id FROM chat_messages WHERE client_message_id = 'today-command-regression'`).first<{ run_id: string }>(); expect(await env.DB.prepare(`SELECT id FROM outbox WHERE json_extract(payload_json, '$.run_id') = ?`).bind(run!.run_id).first()).toBeNull();
    expect(accepted.run_id).toBeTruthy();
  });

  it('resumes a saved bulk confirmation through a text-only ordinary message', async () => {
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;
    const accepted = await acceptWebMessage(env.DB, { workspaceId: WS, chatId, userId: AVI, clientMessageId: 'bulk-source-regression', text: 'Update four records' });
    const source = await env.DB.prepare(`SELECT id FROM messages_in WHERE external_id = 'bulk-source-regression'`).first<{ id: string }>();
    const now = new Date().toISOString(); const targets = ['A', 'B', 'C', 'D'];
    await env.DB.batch([
      env.DB.prepare(`UPDATE agent_runs SET status = 'waiting_for_input' WHERE id = ?`).bind(accepted.run_id),
      env.DB.prepare(`INSERT INTO pending_clarifications (id, workspace_id, chat_id, run_id, source_message_id, requester_user_id, question, intended_operation, missing_fields, operation_payload_json, source_revision, status, created_at, updated_at) VALUES ('bulk-question-regression', ?, ?, ?, ?, ?, 'Confirm those exact four?', 'bulk_operation', '["confirm"]', ?, 0, 'pending', ?, ?)`)
        .bind(WS, chatId, accepted.run_id, source!.id, AVI, JSON.stringify({ version: 1, command_name: 'bulk_operation', action_id: 'bulk-control-regression', args: { targets, calls: [] }, missing_fields: ['confirm'], candidates: targets, source_revision: 0 }), now, now),
    ]);
    const response = await call(`/api/workspaces/${WS}/chats/${chatId}/messages`, { method: 'POST', cookie: aviCookie, headers: CSRF, body: JSON.stringify({ text: 'Yes, save those exact four.', client_message_id: 'bulk-answer-regression', clarification_id: 'bulk-question-regression' }) });
    expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ status: 'resumed', run_id: accepted.run_id });
    expect(await env.DB.prepare(`SELECT status FROM agent_runs WHERE id = ?`).bind(accepted.run_id).first()).toEqual({ status: 'queued' });
    expect(await env.DB.prepare(`SELECT status FROM pending_clarifications WHERE id = 'bulk-question-regression'`).first()).toEqual({ status: 'resolved' });
  });

  it('handles /thinking display, setting level, provider default, and model switch reset', async () => {
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;
    await env.DB.prepare(`UPDATE chats SET model_override = 'gemini-3.1-flash-lite' WHERE id = ?`).bind(chatId).run();

    // 1. /thinking with no args: shows choices and current Provider default
    const res1 = await send(chatId, '/thinking', 'cmd-think-1');
    expect(res1.status).toBe(202);
    const body1 = await res1.json() as { reply: string };
    expect(body1.reply).toContain('Gemini 3.1 Flash-Lite');
    expect(body1.reply).toContain('Provider default');
    expect(body1.reply).toContain('high: High');

    // 2. /thinking high: sets thinking override on chat
    const res2 = await send(chatId, '/thinking high', 'cmd-think-2');
    expect(res2.status).toBe(202);
    const body2 = await res2.json() as { reply: string };
    expect(body2.reply).toContain('High thinking set for Gemini 3.1 Flash-Lite');
    const chatRow = await env.DB.prepare(`SELECT thinking_override_json FROM chats WHERE id = ?`).bind(chatId).first<{ thinking_override_json: string }>();
    expect(JSON.parse(chatRow!.thinking_override_json)).toEqual({ model_key: 'gemini-3.1-flash-lite', choice_id: 'high' });

    // 3. Acceptance pins immutable thinking_snapshot_json
    const accepted = await acceptWebMessage(env.DB, { workspaceId: WS, chatId, userId: AVI, clientMessageId: 'think-pinned-test', text: 'Analyze this data' });
    const runRow = await env.DB.prepare(`SELECT thinking_snapshot_json FROM agent_runs WHERE id = ?`).bind(accepted.run_id).first<{ thinking_snapshot_json: string }>();
    const snapshot = JSON.parse(runRow!.thinking_snapshot_json);
    expect(snapshot).toMatchObject({
      choice_id: 'high',
      choice_label: 'High',
      request: { kind: 'gemini_level', level: 'high' },
    });

    // 4. GET /models returns thinking option with current_choice_id: 'high'
    const modelsRes = await call(`/api/workspaces/${WS}/models?chat_id=${chatId}`, { method: 'GET', cookie: aviCookie });
    expect(modelsRes.status).toBe(200);
    const modelsBody = await modelsRes.json() as ModelListResponse;
    const geminiOption = modelsBody.models.find(m => m.command_key === 'gemini-3.1-flash-lite');
    expect(geminiOption?.thinking).toBeDefined();
    expect(geminiOption?.thinking?.current_choice_id).toBe('high');
    expect(geminiOption?.thinking?.state).toBe('supported');

    // 5. Switching model to mimo-25 clears thinking override to Provider default
    const resModel = await send(chatId, '/model mimo-25', 'cmd-model-switch-reset');
    expect(resModel.status).toBe(202);
    const bodyModel = await resModel.json() as { reply: string };
    expect(bodyModel.reply).toContain('Thinking effort was reset to Provider default');
    const chatAfterSwitch = await env.DB.prepare(`SELECT thinking_override_json FROM chats WHERE id = ?`).bind(chatId).first<{ thinking_override_json: string | null }>();
    expect(chatAfterSwitch!.thinking_override_json).toBeNull();

    // 6. Previously accepted run A retains its original thinking snapshot 'high' even after switch
    const runRowAfter = await env.DB.prepare(`SELECT thinking_snapshot_json FROM agent_runs WHERE id = ?`).bind(accepted.run_id).first<{ thinking_snapshot_json: string }>();
    expect(JSON.parse(runRowAfter!.thinking_snapshot_json).choice_id).toBe('high');

    // 7. Teammate cannot set thinking on someone else's chat
    const hunorTry = await call(`/api/workspaces/${WS}/chats/${chatId}/messages`, {
      method: 'POST',
      cookie: hunorCookie,
      headers: CSRF,
      body: JSON.stringify({ text: '/thinking high', client_message_id: 'hunor-forbidden-think' }),
    });
    expect(hunorTry.status).toBe(403);

    // 8. Replay identical command returns original reply idempotently
    const replay = await send(chatId, '/thinking high', 'cmd-think-2');
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ deduplicated: true });
  });

  it('applies live-verified Muse reasoning effort end to end and qualifies MiMo controls', async () => {
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;
    await env.DB.prepare(`UPDATE chats SET model_override = 'muse-13' WHERE id = ?`).bind(chatId).run();

    // /thinking minimal applies on Muse Spark 1.3 (live-verified effort).
    const res = await send(chatId, '/thinking minimal', 'cmd-think-muse-1');
    expect(res.status).toBe(202);
    const body = await res.json() as { reply: string };
    expect(body.reply).toContain('Minimal thinking set for Muse Spark 1.3 Contributor');
    const chatRow = await env.DB.prepare(`SELECT thinking_override_json FROM chats WHERE id = ?`).bind(chatId).first<{ thinking_override_json: string }>();
    expect(JSON.parse(chatRow!.thinking_override_json)).toEqual({ model_key: 'muse-13', choice_id: 'minimal' });

    // Acceptance pins the nested Responses effort into the immutable snapshot.
    const accepted = await acceptWebMessage(env.DB, { workspaceId: WS, chatId, userId: AVI, clientMessageId: 'think-muse-pinned', text: 'Hello' });
    const runRow = await env.DB.prepare(`SELECT thinking_snapshot_json FROM agent_runs WHERE id = ?`).bind(accepted.run_id).first<{ thinking_snapshot_json: string }>();
    expect(JSON.parse(runRow!.thinking_snapshot_json)).toMatchObject({
      choice_id: 'minimal',
      request: { kind: 'go_responses_effort', effort: 'minimal' },
    });

    // Models endpoint reports the bound choice as current and supported.
    const modelsRes = await call(`/api/workspaces/${WS}/models?chat_id=${chatId}`, { method: 'GET', cookie: aviCookie });
    expect(modelsRes.status).toBe(200);
    const modelsBody = await modelsRes.json() as ModelListResponse;
    const museOption = modelsBody.models.find(m => m.command_key === 'muse-13');
    expect(museOption?.thinking?.current_choice_id).toBe('minimal');
    expect(museOption?.thinking?.state).toBe('supported');

    // MiMo controls are qualified: enum accepted by the gateway is not proof
    // of an honored budget, so selection stays rejected as unverified.
    await send(chatId, '/model mimo-25', 'cmd-model-mimo-verify');
    const mimoRes = await send(chatId, '/thinking low', 'cmd-think-mimo-low');
    expect(mimoRes.status).toBe(202);
    const mimoBody = await mimoRes.json() as { reply: string };
    expect(mimoBody.reply).toContain('not been verified');
  });

  it('defaults to Muse Spark 1.3 with xhigh reasoning effort when unconfigured', async () => {
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;
    // No model_override, no thinking_override_json.
    // 1. Acceptance pins muse-13 and xhigh into immutable thinking snapshot
    const accepted = await acceptWebMessage(env.DB, {
      workspaceId: WS,
      chatId,
      userId: AVI,
      clientMessageId: 'think-muse-default-test',
      text: 'Default model test',
    });
    const runRow = await env.DB
      .prepare(`SELECT model_key, thinking_snapshot_json FROM agent_runs WHERE id = ?`)
      .bind(accepted.run_id)
      .first<{ model_key: string; thinking_snapshot_json: string }>();
    expect(runRow!.model_key).toBe('muse-13');
    expect(JSON.parse(runRow!.thinking_snapshot_json)).toMatchObject({
      choice_id: 'xhigh',
      choice_label: 'Extra high',
      request: { kind: 'go_responses_effort', effort: 'xhigh' },
    });

    // 2. Models endpoint reports muse-13 with effective_choice_id: 'xhigh', is_default: true
    const modelsRes = await call(`/api/workspaces/${WS}/models?chat_id=${chatId}`, { method: 'GET', cookie: aviCookie });
    expect(modelsRes.status).toBe(200);
    const modelsBody = (await modelsRes.json()) as ModelListResponse;
    const museOption = modelsBody.models.find((m) => m.command_key === 'muse-13');
    expect(museOption?.thinking).toBeDefined();
    expect(museOption?.thinking?.effective_choice_id).toBe('xhigh');
    expect(museOption?.thinking?.is_default).toBe(true);
    expect(museOption?.thinking?.current_choice_id).toBeNull();
  });
});

describe('007 round 2 owning-suite pins: shortcut reply and command endpoint', () => {
  it('pins text-only clarification reply shortcut resuming and committing task with due_kind null', async () => {
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;
    const accepted = await acceptWebMessage(env.DB, { workspaceId: WS, chatId, userId: AVI, clientMessageId: 'pin-clar-orig', text: 'Create offer task' });
    const source = await env.DB.prepare(`SELECT id FROM messages_in WHERE external_id = 'pin-clar-orig'`).first<{ id: string }>();
    const now = new Date().toISOString();
    const revision = (await getWorkspaceRevision(env.DB, WS))!.business_revision;
    const clarId = 'pin-clar-shortcut-task';
    await env.DB.batch([
      env.DB.prepare(`UPDATE agent_runs SET status = 'waiting_for_input' WHERE id = ?`).bind(accepted.run_id),
      env.DB.prepare(`INSERT INTO pending_clarifications (id, workspace_id, chat_id, run_id, source_message_id, requester_user_id, question, intended_operation, missing_fields, operation_payload_json, source_revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'When is it due?', 'create_task', '["due"]', ?, ?, 'pending', ?, ?)`)
        .bind(clarId, WS, chatId, accepted.run_id, source!.id, AVI, JSON.stringify({ version: 1, command_name: 'create_task', action_id: 'pin-shortcut-task-action', args: { title: 'Shortcut text answer task', entity_id: null, due: null }, missing_fields: ['due'], source_revision: revision }), revision, now, now),
    ]);

    const res = await call(`/api/workspaces/${WS}/clarifications/${clarId}/reply`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({ text: 'No deadline needed.', client_message_id: 'pin-shortcut-ans-1' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { status: string; clarification_id: string };
    expect(body.status).toBe('resumed');
    expect(body.clarification_id).toBe(clarId);

    const clar = await env.DB.prepare(`SELECT status FROM pending_clarifications WHERE id = ?`).bind(clarId).first<{ status: string }>();
    expect(clar?.status).toBe('resolved');

    const tasks = await env.DB.prepare(`SELECT due_kind FROM tasks WHERE workspace_id = ? AND title = 'Shortcut text answer task'`).bind(WS).all();
    expect(tasks.results).toEqual([{ due_kind: null }]);

    const retry = await call(`/api/workspaces/${WS}/clarifications/${clarId}/reply`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({ text: 'No deadline needed.', client_message_id: 'pin-shortcut-ans-1' }),
    });
    expect(retry.status).toBe(202);
  });

  it('pins bulk approval via clarification shortcut resuming and executing scope once', async () => {
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;
    const accepted = await acceptWebMessage(env.DB, { workspaceId: WS, chatId, userId: AVI, clientMessageId: 'pin-bulk-orig', text: 'Batch change' });
    const source = await env.DB.prepare(`SELECT id FROM messages_in WHERE external_id = 'pin-bulk-orig'`).first<{ id: string }>();
    const now = new Date().toISOString();
    const targets = ['X', 'Y', 'Z'];
    const clarId = 'pin-clar-shortcut-bulk';
    await env.DB.batch([
      env.DB.prepare(`UPDATE agent_runs SET status = 'waiting_for_input' WHERE id = ?`).bind(accepted.run_id),
      env.DB.prepare(`INSERT INTO pending_clarifications (id, workspace_id, chat_id, run_id, source_message_id, requester_user_id, question, intended_operation, missing_fields, operation_payload_json, source_revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'Confirm bulk operation?', 'bulk_operation', '["confirm"]', ?, 0, 'pending', ?, ?)`)
        .bind(clarId, WS, chatId, accepted.run_id, source!.id, AVI, JSON.stringify({ version: 1, command_name: 'bulk_operation', action_id: 'pin-shortcut-bulk-action', args: { targets, calls: [] }, missing_fields: ['confirm'], candidates: targets, source_revision: 0 }), now, now),
    ]);

    const res = await call(`/api/workspaces/${WS}/clarifications/${clarId}/reply`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({ text: 'Yes, proceed with those three.', client_message_id: 'pin-shortcut-bulk-ans' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('resumed');

    expect(await env.DB.prepare(`SELECT status FROM pending_clarifications WHERE id = ?`).bind(clarId).first()).toEqual({ status: 'resolved' });
    expect(await env.DB.prepare(`SELECT status FROM agent_runs WHERE id = ?`).bind(accepted.run_id).first()).toEqual({ status: 'queued' });
  });

  it('closes a dead question with 410 and retires it when its run already ended', async () => {
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;
    const accepted = await acceptWebMessage(env.DB, { workspaceId: WS, chatId, userId: AVI, clientMessageId: 'dead-q-orig', text: 'Log this expense' });
    const source = await env.DB.prepare(`SELECT id FROM messages_in WHERE external_id = 'dead-q-orig'`).first<{ id: string }>();
    const now = new Date().toISOString();
    const clarId = 'dead-q-clar-1';
    const runsBefore = await env.DB.prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE chat_id = ?`).bind(chatId).first<{ n: number }>();
    await env.DB.batch([
      env.DB.prepare(`UPDATE agent_runs SET status = 'failed' WHERE id = ?`).bind(accepted.run_id),
      env.DB.prepare(`INSERT INTO pending_clarifications (id, workspace_id, chat_id, run_id, source_message_id, requester_user_id, question, intended_operation, missing_fields, operation_payload_json, source_revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'Which account?', 'log_event', '[]', ?, 0, 'pending', ?, ?)`)
        .bind(clarId, WS, chatId, accepted.run_id, source!.id, AVI, null, now, now),
    ]);

    const res = await call(`/api/workspaces/${WS}/clarifications/${clarId}/reply`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({ text: 'Savings account.', client_message_id: 'dead-q-ans-1' }),
    });
    expect(res.status).toBe(410);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('question_closed');
    expect(body.error.message).toContain('failed');

    // The dead question is retired so answers stop failing forever; the run
    // is untouched and no continuation run was minted.
    expect(await env.DB.prepare(`SELECT status FROM pending_clarifications WHERE id = ?`).bind(clarId).first()).toEqual({ status: 'superseded' });
    expect(await env.DB.prepare(`SELECT status FROM agent_runs WHERE id = ?`).bind(accepted.run_id).first()).toEqual({ status: 'failed' });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE chat_id = ?`).bind(chatId).first()).toEqual(runsBefore);
  });

  it('answers an already-resolved question with 409 instead of a bare failure', async () => {
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;
    const accepted = await acceptWebMessage(env.DB, { workspaceId: WS, chatId, userId: AVI, clientMessageId: 'dead-q-orig-2', text: 'Log this too' });
    const source = await env.DB.prepare(`SELECT id FROM messages_in WHERE external_id = 'dead-q-orig-2'`).first<{ id: string }>();
    const now = new Date().toISOString();
    const clarId = 'dead-q-clar-2';
    await env.DB.batch([
      env.DB.prepare(`UPDATE agent_runs SET status = 'waiting_for_input' WHERE id = ?`).bind(accepted.run_id),
      env.DB.prepare(`INSERT INTO pending_clarifications (id, workspace_id, chat_id, run_id, source_message_id, requester_user_id, question, intended_operation, missing_fields, operation_payload_json, source_revision, status, answer_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'Which account?', 'log_event', '[]', ?, 0, 'resolved', ?, ?, ?)`)
        .bind(clarId, WS, chatId, accepted.run_id, source!.id, AVI, null, source!.id, now, now),
    ]);

    const res = await call(`/api/workspaces/${WS}/clarifications/${clarId}/reply`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({ text: 'A different answer.', client_message_id: 'dead-q-ans-2' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('already_resolved');
    // Rejected before acceptance: no answer row was stored for the retry.
    expect(await env.DB.prepare(`SELECT id FROM messages_in WHERE external_id = 'dead-q-ans-2'`).first()).toBeNull();
  });

  it('pins /model switch, default clear, and unknown key via POST commands route', async () => {
    const now = new Date().toISOString();
    const model = PRODUCTION_REGISTRY.entries.find(entry => entry.provider === 'opencode_go' && entry.lifecycle === 'active')!;
    await env.DB.prepare(`INSERT INTO provider_credentials (workspace_id, provider, encrypted_key, key_nonce, status, created_at, updated_at) VALUES (?, 'opencode_go', 'synthetic-test-only', 'synthetic', 'available', ?, ?) ON CONFLICT(workspace_id, provider) DO UPDATE SET status = 'available'`).bind(WS, now, now).run();
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;

    const resSwitch = await call(`/api/workspaces/${WS}/chats/${chatId}/commands`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({ text: `/model ${model.commandKey}`, client_message_id: 'pin-cmd-model-switch' }),
    });
    expect(resSwitch.status).toBe(200);
    expect(await env.DB.prepare(`SELECT model_override FROM chats WHERE id = ?`).bind(chatId).first()).toEqual({ model_override: model.commandKey });

    const resClear = await call(`/api/workspaces/${WS}/chats/${chatId}/commands`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({ text: '/model default', client_message_id: 'pin-cmd-model-default' }),
    });
    expect(resClear.status).toBe(200);
    expect(await env.DB.prepare(`SELECT model_override FROM chats WHERE id = ?`).bind(chatId).first()).toEqual({ model_override: null });

    const resUnknown = await call(`/api/workspaces/${WS}/chats/${chatId}/commands`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({ text: '/model nonexistent-model-key', client_message_id: 'pin-cmd-model-unknown' }),
    });
    expect(resUnknown.status).toBe(200);
    const unknownBody = await resUnknown.json() as { reply: string };
    expect(unknownBody.reply).toContain('unavailable');
    expect(await env.DB.prepare(`SELECT model_override FROM chats WHERE id = ?`).bind(chatId).first()).toEqual({ model_override: null });
  });

  it('pins /workspace switch recording target effect via POST commands route', async () => {
    const now = new Date().toISOString();
    const targetWs = 'ws-pin-cmd-target';
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?, 'Design Studio', ?, ?, ?)`).bind(targetWs, AVI, now, now),
      env.DB.prepare(`INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)`).bind(targetWs, AVI, now, now, now),
    ]);
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;

    const res = await call(`/api/workspaces/${WS}/chats/${chatId}/commands`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({ text: '/workspace Design Studio', client_message_id: 'pin-cmd-ws-switch' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { reply: string; selected_workspace_id: string };
    expect(body.reply).toContain('Switched to Design Studio');
    expect(body.selected_workspace_id).toBe(targetWs);
    expect(await env.DB.prepare(`SELECT workspace_id FROM chats WHERE id = ?`).bind(chatId).first()).toEqual({ workspace_id: WS });
  });

  it('pins /undo command execution removing entity exactly once via POST commands route', async () => {
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;
    const actionId = await commitEntity('PinCmdUndoEntity', chatId);

    expect(await env.DB.prepare(`SELECT id FROM entities WHERE name = 'PinCmdUndoEntity' AND workspace_id = ?`).bind(WS).first()).toBeTruthy();

    const res = await call(`/api/workspaces/${WS}/chats/${chatId}/commands`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({ text: `/undo ${actionId}`, client_message_id: 'pin-cmd-undo-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { reply: string };
    expect(body.reply).toBeTruthy();

    expect(await env.DB.prepare(`SELECT id FROM entities WHERE name = 'PinCmdUndoEntity' AND workspace_id = ?`).bind(WS).first()).toBeNull();

    const revertEvents = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND kind = 'revert' AND reverts_event_id IN (SELECT id FROM events WHERE action_id = ?)`
    ).bind(WS, actionId).first<{ n: number }>();
    expect(Number(revertEvents?.n)).toBe(1);

    const retry = await call(`/api/workspaces/${WS}/chats/${chatId}/commands`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({ text: `/undo ${actionId}`, client_message_id: 'pin-cmd-undo-1' }),
    });
    expect(retry.status).toBe(200);
    const revertEventsAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND kind = 'revert' AND reverts_event_id IN (SELECT id FROM events WHERE action_id = ?)`
    ).bind(WS, actionId).first<{ n: number }>();
    expect(Number(revertEventsAfter?.n)).toBe(1);
  });
});

describe('007 acceptance transaction boundaries', () => {
  it('replays identical concurrent acceptance and commits exactly one input, run and outbox intent', async () => {
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI })).id;
    const params = { workspaceId: WS, chatId, userId: AVI, clientMessageId: 'concurrent-acceptance-regression', text: 'Read the latest visit' };
    const responses = await Promise.all([acceptWebMessage(env.DB, params), acceptWebMessage(env.DB, params)]);
    expect(responses[0]).toEqual(responses[1]);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages_in WHERE external_id = ?`).bind(params.clientMessageId).first()).toEqual({ n: 1 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE chat_id = ?`).bind(chatId).first()).toEqual({ n: 1 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE json_extract(payload_json, '$.run_id') = ?`).bind(responses[0]!.run_id).first()).toEqual({ n: 1 });
  });

  it('rolls back the entire acceptance batch when membership is removed after precheck', async () => {
    const chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: HUNOR })).id;
    const before = await env.DB.prepare(`SELECT last_acceptance_sequence FROM workspaces WHERE id = ?`).bind(WS).first();
    const now = new Date().toISOString();
    const db = { prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => {
      await env.DB.prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`).bind(WS, HUNOR).run();
      return env.DB.batch(statements);
    } } as unknown as D1Database;
    try {
      await expect(acceptWebMessage(db, { workspaceId: WS, chatId, userId: HUNOR, clientMessageId: 'late-membership-regression', text: 'This must never be accepted' })).rejects.toThrow('no longer an active member');
      expect(await env.DB.prepare(`SELECT id FROM messages_in WHERE external_id = 'late-membership-regression'`).first()).toBeNull();
      expect(await env.DB.prepare(`SELECT id FROM chat_messages WHERE chat_id = ?`).bind(chatId).first()).toBeNull();
      expect(await env.DB.prepare(`SELECT id FROM agent_runs WHERE chat_id = ?`).bind(chatId).first()).toBeNull();
      expect(await env.DB.prepare(`SELECT last_acceptance_sequence FROM workspaces WHERE id = ?`).bind(WS).first()).toEqual(before);
    } finally {
      await env.DB.prepare(`INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'member', ?, ?, ?)`).bind(WS, HUNOR, now, now, now).run();
    }
  });
});

describe('/model default honesty and resolver-parity availability', () => {
  const send = (chatId: string, text: string, id: string) =>
    call(`/api/workspaces/ws-model-honesty/chats/${chatId}/messages`, {
      method: 'POST',
      cookie: aviCookie,
      headers: CSRF,
      body: JSON.stringify({ text, client_message_id: id }),
    });

  it('refuses false readiness and lists only resolver-usable models', async () => {
    const now = new Date().toISOString();
    const ws = 'ws-model-honesty';
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?, 'Honesty WS', ?, ?, ?)`)
        .bind(ws, AVI, now, now),
      env.DB.prepare(`INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)`)
        .bind(ws, AVI, now, now, now),
      env.DB.prepare(`INSERT INTO provider_credentials (workspace_id, provider, encrypted_key, key_nonce, status, created_at, updated_at) VALUES (?, 'opencode_go', 'synthetic-test-only', 'synthetic', 'available', ?, ?)`)
        .bind(ws, now, now),
      env.DB.prepare(`INSERT INTO provider_credentials (workspace_id, provider, encrypted_key, key_nonce, status, created_at, updated_at) VALUES (?, 'gemini', 'synthetic-test-only', 'synthetic', 'available', ?, ?)`)
        .bind(ws, now, now),
    ]);
    const chatId = (await createChat(env.DB, { workspaceId: ws, authorUserId: AVI })).id;

    // No workspace default: clearing the override must not announce readiness.
    const noDefault = await send(chatId, '/model default', 'model-honest-no-default');
    expect(noDefault.status).toBe(202);
    const noDefaultBody = (await noDefault.json()) as { reply: string };
    expect(noDefaultBody.reply).toContain('no workspace model is set yet');
    expect(noDefaultBody.reply).toContain('/model mimo-25');
    expect(await env.DB.prepare(`SELECT model_override FROM chats WHERE id = ?`).bind(chatId).first())
      .toEqual({ model_override: null });

    // Unverified entries stay unavailable even with a healthy credential (resolver parity).
    const models = await callJson<ModelListResponse>(`/api/workspaces/${ws}/models?chat_id=${chatId}`, {
      cookie: aviCookie,
    });
    const byKey = new Map(models.models.map((model) => [model.command_key, model]));
    expect(byKey.get('mimo-25')?.available).toBe(true);
    expect(byKey.get('gemini-3.1-flash-lite')?.available).toBe(true);
    expect(byKey.get('muse-12')?.available).toBe(true);
    expect(byKey.get('gemini-3.5-flash-lite')?.available).toBe(true);
    expect(byKey.get('gemini-preview-unverified')?.available).toBe(false);

    // A default pointing at an unusable entry is reported, not confirmed.
    await env.DB.prepare(
      `INSERT INTO workspace_settings (workspace_id, default_model, created_at, updated_at) VALUES (?, 'gemini-preview-unverified', ?, ?)`,
    ).bind(ws, now, now).run();
    const badDefault = await send(chatId, '/model default', 'model-honest-bad-default');
    expect(badDefault.status).toBe(202);
    const badDefaultBody = (await badDefault.json()) as { reply: string };
    expect(badDefaultBody.reply).toContain('not usable here');
    expect(badDefaultBody.reply).toContain('/model mimo-25');

    // A usable default is confirmed by display name plus the verified voice route.
    await env.DB.prepare(`UPDATE workspace_settings SET default_model = 'mimo-25', updated_at = ? WHERE workspace_id = ?`)
      .bind(now, ws).run();
    const goodDefault = await send(chatId, '/model default', 'model-honest-good-default');
    expect(goodDefault.status).toBe(202);
    const goodDefaultBody = (await goodDefault.json()) as { reply: string };
    expect(goodDefaultBody.reply).toContain('MiMo V2.5');
    expect(goodDefaultBody.reply).toContain('Voice notes are not available with this model yet.');
  });
});

describe('Dispatch wake-up hint on acceptance', () => {
  const postMessage = (
    chatId: string,
    clientMessageId: string,
    text: string,
    ctx?: ExecutionContext,
    bindings?: {
      actor?: { fetch: (req: Request) => Promise<Response> };
      queue?: { send: (body: unknown) => Promise<void> };
    },
  ) => {
    const request = new Request(`http://localhost/api/workspaces/${WS}/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { Cookie: aviCookie, ...CSRF },
      body: JSON.stringify({ client_message_id: clientMessageId, text }),
    });
    const routeEnv = bindings
      ? {
        ...env,
        ...(bindings.actor
          ? { WORKSPACE_ACTOR: { idFromName: (name: string) => ({ name }), get: (_id: unknown) => bindings.actor } }
          : {}),
        ...(bindings.queue ? { DISPATCH_QUEUE: bindings.queue } : {}),
      }
      : env;
    return handleCreateMessage(request, routeEnv as typeof env, WS, chatId, 'req-wake-up', ctx);
  };

  it('wakes the workspace actor directly on accepted messages (no queue batching)', async () => {
    const actorCalls: unknown[] = [];
    const queueSends: unknown[] = [];
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as unknown as ExecutionContext;

    const res = await postMessage(aviChat, 'cm-wake-up-1', 'Wake the dispatcher, please.', ctx, {
      actor: {
        fetch: async (req: Request) => {
          actorCalls.push(await req.json());
          return new Response(JSON.stringify({ status: 'accepted' }), { status: 202 });
        },
      },
      queue: { send: async (body: unknown) => { queueSends.push(body); } },
    });
    expect(res.status).toBe(202);
    await Promise.all(pending);
    expect(actorCalls).toContainEqual(expect.objectContaining({ action: 'dispatch', workspace_id: WS }));
    expect(queueSends).toEqual([]);
  });

  it('still accepts when no queue binding or context exists (cron remains the backstop)', async () => {
    const res = await postMessage(aviChat, 'cm-wake-up-2', 'Acceptance must not depend on the hint.');
    expect(res.status).toBe(202);

    const resNoQueue = await postMessage(
      aviChat,
      'cm-wake-up-3',
      'Acceptance with context but no queue binding.',
      { waitUntil: () => undefined } as unknown as ExecutionContext,
    );
    expect(resNoQueue.status).toBe(202);
  });

  it('a failing actor wake never fails acceptance', async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as unknown as ExecutionContext;
    const res = await postMessage(aviChat, 'cm-wake-up-4', 'The hint may fail; the message must land.', ctx, {
      actor: {
        fetch: async () => { throw new Error('actor exploded'); },
      },
      queue: { send: async () => { throw new Error('queue must not be used on the interactive path'); } },
    });
    expect(res.status).toBe(202);
    await Promise.all(pending.map((promise) => promise.catch(() => undefined)));

    const stored = await env.DB.prepare(`SELECT id FROM chat_messages WHERE chat_id = ? AND client_message_id = ?`)
      .bind(aviChat, 'cm-wake-up-4')
      .first<{ id: string }>();
    expect(stored?.id).toBeTruthy();
  });

  it('publishDispatchHint is a silent no-op without context', () => {
    expect(() => publishDispatchHint(undefined, env as never, WS)).not.toThrow();
  });
});

describe('UI command controls remain auditable without becoming chat messages', () => {
  it('saves a model exactly once, returns its effect, and leaves transcript/context clean', async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO provider_credentials (workspace_id, provider, encrypted_key, key_nonce, status, created_at, updated_at) VALUES (?, 'opencode_go', 'synthetic-test-only', 'synthetic', 'available', ?, ?) ON CONFLICT(workspace_id, provider) DO UPDATE SET status = 'available'`).bind(WS, now, now).run();
    const model = PRODUCTION_REGISTRY.entries.find(entry => entry.provider === 'opencode_go' && entry.lifecycle === 'active')!;
    const chat = await createChat(env.DB, { workspaceId: WS, authorUserId: AVI });
    const endpoint = `/api/workspaces/${WS}/chats/${chat.id}/commands`;
    const body = { text: `/model ${model.commandKey}`, client_message_id: 'ui-control-model', presentation: 'control' };
    const first = await call(endpoint, { method: 'POST', cookie: aviCookie, headers: CSRF, body: JSON.stringify(body) });
    expect(first.status).toBe(200);
    const accepted = await first.json() as { run_id: string; command_applied: boolean };
    expect(accepted.command_applied).toBe(true);
    const replay = await call(endpoint, { method: 'POST', cookie: aviCookie, headers: CSRF, body: JSON.stringify(body) });
    expect(await replay.json()).toMatchObject({ run_id: accepted.run_id, command_applied: true });
    expect(await env.DB.prepare(`SELECT model_override FROM chats WHERE id = ?`).bind(chat.id).first()).toEqual({ model_override: model.commandKey });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?`).bind(chat.id).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages_in WHERE external_id = 'ui-control-model'`).first()).toEqual({ n: 1 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE json_extract(payload_json, '$.run_id') = ?`).bind(accepted.run_id).first()).toEqual({ n: 0 });
    const audit = await env.DB.prepare(`SELECT payload_json FROM run_activity WHERE run_id = ? AND type = 'answer_saved'`).bind(accepted.run_id).first<{ payload_json: string }>();
    expect(JSON.parse(audit!.payload_json)).toMatchObject({ presentation: 'control', command_applied: true });
    const collision = await call(endpoint, { method: 'POST', cookie: aviCookie, headers: CSRF, body: JSON.stringify({ ...body, presentation: undefined }) });
    expect(collision.status).toBe(409);
  });
  it('applies thinking, replays an older action without reverting a newer selection, and rejects invalid levels', async () => {
    const chat = await createChat(env.DB, { workspaceId: WS, authorUserId: AVI, modelOverride: 'gemini-3.1-flash-lite' });
    const endpoint = `/api/workspaces/${WS}/chats/${chat.id}/commands`;
    const invoke = (text: string, id: string, cookie = aviCookie) => call(endpoint, { method: 'POST', cookie, headers: CSRF, body: JSON.stringify({ text, client_message_id: id, presentation: 'control' }) });
    expect((await invoke('/thinking high', 'ui-control-thinking-high')).status).toBe(200);
    const selected = await callJson<ModelListResponse>(`/api/workspaces/${WS}/models?chat_id=${chat.id}`, { cookie: aviCookie });
    expect(selected.models.find(model => model.is_current)?.thinking?.current_choice_id).toBe('high');
    expect((await invoke('/thinking default', 'ui-control-thinking-reset')).status).toBe(200);
    expect((await invoke('/thinking high', 'ui-control-thinking-high')).status).toBe(200);
    expect(await env.DB.prepare(`SELECT thinking_override_json FROM chats WHERE id = ?`).bind(chat.id).first()).toEqual({ thinking_override_json: null });
    expect((await invoke('/thinking imaginary', 'ui-control-thinking-invalid')).status).toBe(422);
    expect((await invoke('/thinking high', 'ui-control-thinking-hunor', hunorCookie)).status).toBe(403);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?`).bind(chat.id).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages_in WHERE external_id IN ('ui-control-thinking-invalid', 'ui-control-thinking-hunor')`).first()).toEqual({ n: 0 });
  });
  it('returns helpful command output directly without queuing an agent or inserting a chat bubble', async () => {
    const chat = await createChat(env.DB, { workspaceId: WS, authorUserId: AVI });
    const response = await call(`/api/workspaces/${WS}/chats/${chat.id}/commands`, { method: 'POST', cookie: aviCookie, headers: CSRF, body: JSON.stringify({ text: '/help', client_message_id: 'ui-control-help', presentation: 'control' }) });
    expect(response.status).toBe(200); const result = await response.json() as { reply: string; command_applied: boolean; run_id: string };
    expect(result.reply).toContain('/model'); expect(result.command_applied).toBe(false);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?`).bind(chat.id).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare(`SELECT executor_kind, status FROM agent_runs WHERE id = ?`).bind(result.run_id).first()).toEqual({ executor_kind: 'command', status: 'succeeded' });
  });
  it('deletes an existing chat with messages/runs and handles non-existent chat', async () => {
    const chat = await createChat(env.DB, { workspaceId: WS, authorUserId: AVI, clientChatId: 'new-b6ed665d-2121-490c-962c-710f03ccc7cf' });
    await call(`/api/workspaces/${WS}/chats/${chat.id}/commands`, { method: 'POST', cookie: aviCookie, headers: CSRF, body: JSON.stringify({ text: '/help', client_message_id: 'delete-test-cmd', presentation: 'control' }) });
    const deleteRes = await call(`/api/workspaces/${WS}/chats/${chat.id}`, { method: 'DELETE', cookie: aviCookie, headers: CSRF });
    expect(deleteRes.status).toBe(200);

    const nonExistent = await call(`/api/workspaces/${WS}/chats/chat_does_not_exist`, { method: 'DELETE', cookie: aviCookie, headers: CSRF });
    expect(nonExistent.status).toBe(404);
  });
});



import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
// @ts-expect-error vite raw import
import migration0001Sql from '../../../migrations/0001_identity.sql?raw';
// @ts-expect-error vite raw import
import migration0002Sql from '../../../migrations/0002_conversations_sources.sql?raw';
// @ts-expect-error vite raw import
import migration0006Sql from '../../../migrations/0006_actor_hardening.sql?raw';
// @ts-expect-error vite raw import
import migration0007Sql from '../../../migrations/0007_outbox_claim_owner.sql?raw';
import { AUTH_BOUNDS } from '@otis/contracts';
import type {
  AcceptMessageResponse,
  Chat,
  ChatMessage,
  HttpErrorResponse,
} from '@otis/contracts';
import { executeEchoTurn } from '../src/inbox/echo.js';
import { acceptWebMessage, ForbiddenError } from '../src/inbox/repository.js';
import { acceptTelegramInbound } from '../src/inbox/telegram.js';
import { handleTelegramWebhook } from '../src/routes/inbound.js';
import { sha256 } from '@otis/identity';

describe('Worker Conversations & Inbound Integration (workerd runtime)', () => {
  const workspaceId = 'ws-conv-test';
  let aviCookie: string;
  let hunorCookie: string;
  const aviUserId = 'usr_avi_1';
  const hunorUserId = 'usr_hunor_2';

  beforeAll(async () => {
    // 1. Apply actual migration SQL files directly from disk
    for (const sql of [migration0001Sql, migration0002Sql, migration0006Sql, migration0007Sql]) {
      const statements = sql
        .split(';')
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);

      for (const stmt of statements) {
        await env.DB.prepare(stmt).run();
      }
    }

    // Configure test environment
    env.ENVIRONMENT = 'test';
    env.TELEGRAM_WEBHOOK_SECRET = 'test_webhook_secret_999';
    env.TELEGRAM_BOT_INSTALLATION_ID = 'test_bot';

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    // Seed Avi
    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
       VALUES (?, 'fb_avi', 'avi@kerning.test', 'Avi', ?, ?)`
    )
      .bind(aviUserId, now, now)
      .run();

    // Seed Workspace
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, last_acceptance_sequence, created_at, updated_at)
       VALUES (?, 'Kerning Conv Test', ?, 0, 1, 0, ?, ?)`
    )
      .bind(workspaceId, aviUserId, now, now)
      .run();

    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'owner', ?, ?, ?)`
    )
      .bind(workspaceId, aviUserId, now, now, now)
      .run();

    const aviRawToken = 'session_token_avi_test';
    const aviTokenHash = await sha256(aviRawToken);
    await env.DB.prepare(
      `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
       VALUES ('sess_avi', ?, ?, ?, ?, NULL, ?)`
    )
      .bind(aviTokenHash, aviUserId, now, expiresAt, now)
      .run();
    aviCookie = `${AUTH_BOUNDS.COOKIE_NAME}=${aviRawToken}`;

    // Seed Hunor
    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
       VALUES (?, 'fb_hunor', 'hunor@kerning.test', 'Hunor', ?, ?)`
    )
      .bind(hunorUserId, now, now)
      .run();

    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'member', ?, ?, ?)`
    )
      .bind(workspaceId, hunorUserId, now, now, now)
      .run();

    const hunorRawToken = 'session_token_hunor_test';
    const hunorTokenHash = await sha256(hunorRawToken);
    await env.DB.prepare(
      `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
       VALUES ('sess_hunor', ?, ?, ?, ?, NULL, ?)`
    )
      .bind(hunorTokenHash, hunorUserId, now, expiresAt, now)
      .run();
    hunorCookie = `${AUTH_BOUNDS.COOKIE_NAME}=${hunorRawToken}`;
  });

  let createdChatId: string;

  it('allows authenticated member Avi to create a chat', async () => {
    const res = await SELF.fetch(
      `http://localhost/api/workspaces/${workspaceId}/chats`,
      {
        method: 'POST',
        headers: {
          cookie: aviCookie,
          origin: 'http://localhost',
          [AUTH_BOUNDS.CSRF_HEADER]: '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Kerning Client Discussion',
        }),
      },
    );

    expect(res.status).toBe(201);
    const data = (await res.json()) as { chat: Chat };
    expect(data.chat).toBeDefined();
    expect(data.chat.title).toBe('Kerning Client Discussion');
    expect(data.chat.author_user_id).toBe(aviUserId);
    expect(data.chat.workspace_id).toBe(workspaceId);
    expect(data.chat.activity_cursor).toBe(0);

    createdChatId = data.chat.id;
  });

  it('allows teammate Hunor to read Avi chat and messages (equal member visibility)', async () => {
    const res = await SELF.fetch(
      `http://localhost/api/workspaces/${workspaceId}/chats/${createdChatId}`,
      {
        headers: {
          cookie: hunorCookie,
        },
      },
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as { chat: Chat };
    expect(data.chat.id).toBe(createdChatId);
    expect(data.chat.author_user_id).toBe(aviUserId);
  });

  it('rejects teammate Hunor attempting to append a message to Avi chat (author restriction)', async () => {
    const res = await SELF.fetch(
      `http://localhost/api/workspaces/${workspaceId}/chats/${createdChatId}/messages`,
      {
        method: 'POST',
        headers: {
          cookie: hunorCookie,
          origin: 'http://localhost',
          [AUTH_BOUNDS.CSRF_HEADER]: '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_message_id: 'hunor-uuid-forbidden',
          text: 'Trying to post in Avi chat',
        }),
      },
    );

    expect(res.status).toBe(403);
    const errorJson = (await res.json()) as HttpErrorResponse;
    expect(errorJson.error.code).toBe('forbidden');
  });

  const clientMsgId1 = 'client-msg-uuid-001';
  let recordedMessageId: string;
  let recordedRunId: string;

  it('durable message acceptance: Avi sends message, receives HTTP 202 and commits atomic records', async () => {
    const res = await SELF.fetch(
      `http://localhost/api/workspaces/${workspaceId}/chats/${createdChatId}/messages`,
      {
        method: 'POST',
        headers: {
          cookie: aviCookie,
          origin: 'http://localhost',
          [AUTH_BOUNDS.CSRF_HEADER]: '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_message_id: clientMsgId1,
          text: 'Send Bistro the offer by Friday',
        }),
      },
    );

    expect(res.status).toBe(202);
    const data = (await res.json()) as AcceptMessageResponse;
    expect(data.status).toBe('accepted');
    expect(data.message_id).toMatch(/^msg_/);
    expect(data.run_id).toMatch(/^run_/);
    expect(data.acceptance_sequence).toBe(1);

    recordedMessageId = data.message_id;
    recordedRunId = data.run_id;

    // Verify D1 records directly
    const msgIn = await env.DB
      .prepare(`SELECT * FROM messages_in WHERE external_id = ?`)
      .bind(clientMsgId1)
      .first<Record<string, unknown>>();

    expect(msgIn).toBeDefined();
    expect(msgIn!['status']).toBe('queued');
    expect(msgIn!['acceptance_sequence']).toBe(1);
    expect(msgIn!['workspace_id']).toBe(workspaceId);
    expect(msgIn!['channel']).toBe('web');

    const chatMsg = await env.DB
      .prepare(`SELECT * FROM chat_messages WHERE id = ?`)
      .bind(recordedMessageId)
      .first<Record<string, unknown>>();

    expect(chatMsg).toBeDefined();
    expect(chatMsg!['content_text']).toBe('Send Bistro the offer by Friday');
    expect(chatMsg!['sequence']).toBe(1);

    const run = await env.DB
      .prepare(`SELECT * FROM agent_runs WHERE id = ?`)
      .bind(recordedRunId)
      .first<Record<string, unknown>>();

    expect(run).toBeDefined();
    expect(run!['status']).toBe('queued');
    expect(run!['executor_kind']).toBe('agent');

    const activity = await env.DB
      .prepare(`SELECT * FROM run_activity WHERE run_id = ?`)
      .bind(recordedRunId)
      .first<Record<string, unknown>>();

    expect(activity).toBeDefined();
    expect(activity!['type']).toBe('message_accepted');
    expect(activity!['cursor']).toBe(1);

    const outbox = await env.DB
      .prepare(`SELECT * FROM outbox WHERE workspace_id = ?`)
      .bind(workspaceId)
      .first<Record<string, unknown>>();

    expect(outbox).toBeDefined();
    expect(outbox!['destination']).toBe('workspace_actor');
    expect(outbox!['status']).toBe('pending');
  });

  it('idempotent retry: resending exact same UUID and payload returns original 202 IDs without duplicate rows', async () => {
    const res = await SELF.fetch(
      `http://localhost/api/workspaces/${workspaceId}/chats/${createdChatId}/messages`,
      {
        method: 'POST',
        headers: {
          cookie: aviCookie,
          origin: 'http://localhost',
          [AUTH_BOUNDS.CSRF_HEADER]: '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_message_id: clientMsgId1,
          text: 'Send Bistro the offer by Friday',
        }),
      },
    );

    expect(res.status).toBe(202);
    const data = (await res.json()) as AcceptMessageResponse;
    expect(data.status).toBe('accepted');
    expect(data.message_id).toBe(recordedMessageId);
    expect(data.run_id).toBe(recordedRunId);
    expect(data.acceptance_sequence).toBe(1);

    // Verify row counts in messages_in and chat_messages did not increase
    const countIn = await env.DB
      .prepare(`SELECT COUNT(*) as count FROM messages_in WHERE external_id = ?`)
      .bind(clientMsgId1)
      .first<{ count: number }>();
    expect(countIn?.count).toBe(1);

    const countMsg = await env.DB
      .prepare(`SELECT COUNT(*) as count FROM chat_messages WHERE client_message_id = ?`)
      .bind(clientMsgId1)
      .first<{ count: number }>();
    expect(countMsg?.count).toBe(1);
  });

  it('conflicting reuse: resending same UUID with different payload returns 409 Conflict', async () => {
    const res = await SELF.fetch(
      `http://localhost/api/workspaces/${workspaceId}/chats/${createdChatId}/messages`,
      {
        method: 'POST',
        headers: {
          cookie: aviCookie,
          origin: 'http://localhost',
          [AUTH_BOUNDS.CSRF_HEADER]: '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_message_id: clientMsgId1,
          text: 'Completely different text payload',
        }),
      },
    );

    expect(res.status).toBe(409);
    const errorJson = (await res.json()) as HttpErrorResponse;
    expect(errorJson.error.code).toBe('conflict');
  });

  it('monotonic sequences: second message increments workspace acceptance sequence and chat activity cursor', async () => {
    const clientMsgId2 = 'client-msg-uuid-002';
    const res = await SELF.fetch(
      `http://localhost/api/workspaces/${workspaceId}/chats/${createdChatId}/messages`,
      {
        method: 'POST',
        headers: {
          cookie: aviCookie,
          origin: 'http://localhost',
          [AUTH_BOUNDS.CSRF_HEADER]: '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_message_id: clientMsgId2,
          text: 'Second follow-up message',
        }),
      },
    );

    expect(res.status).toBe(202);
    const data = (await res.json()) as AcceptMessageResponse;
    expect(data.acceptance_sequence).toBe(2);

    const chat = await env.DB
      .prepare(`SELECT activity_cursor FROM chats WHERE id = ?`)
      .bind(createdChatId)
      .first<{ activity_cursor: number }>();
    expect(chat?.activity_cursor).toBe(2);
  });

  it('deterministic echo harness: processes run, appends assistant message and publishes activities', async () => {
    const echoResult = await executeEchoTurn(env.DB, recordedRunId);
    expect(echoResult.replyText).toBe('Echo: Send Bistro the offer by Friday');
    expect(echoResult.chatId).toBe(createdChatId);

    // Verify run status transitioned to 'succeeded'
    const run = await env.DB
      .prepare(`SELECT status FROM agent_runs WHERE id = ?`)
      .bind(recordedRunId)
      .first<{ status: string }>();
    expect(run?.status).toBe('succeeded');

    // Verify source message status transitioned to 'processed'
    const msgIn = await env.DB
      .prepare(`SELECT status FROM messages_in WHERE external_id = ?`)
      .bind(clientMsgId1)
      .first<{ status: string }>();
    expect(msgIn?.status).toBe('processed');

    // Verify outbox transitioned to 'delivered'
    const outbox = await env.DB
      .prepare(`SELECT status FROM outbox WHERE instr(payload_json, ?) > 0`)
      .bind(recordedRunId)
      .first<{ status: string }>();
    expect(outbox?.status).toBe('delivered');

    // Verify chat activity cursor advanced
    const chat = await env.DB
      .prepare(`SELECT activity_cursor FROM chats WHERE id = ?`)
      .bind(createdChatId)
      .first<{ activity_cursor: number }>();
    // Was 2 after message 2; echo adds 2 -> 4
    expect(chat?.activity_cursor).toBe(4);

    // Verify messages list includes the echo reply
    const msgsRes = await SELF.fetch(
      `http://localhost/api/workspaces/${workspaceId}/chats/${createdChatId}/messages`,
      {
        headers: { cookie: aviCookie },
      },
    );
    expect(msgsRes.status).toBe(200);
    const msgsData = (await msgsRes.json()) as { messages: ChatMessage[] };
    expect(msgsData.messages.some((m) => m.content_text.includes('Echo: Send Bistro the offer'))).toBe(true);
  });

  it('deterministic echo harness: is retry-safe and idempotent on re-execution', async () => {
    // Calling executeEchoTurn a second time on the already succeeded run
    const secondResult = await executeEchoTurn(env.DB, recordedRunId);
    expect(secondResult.replyText).toBe('Echo: Send Bistro the offer by Friday');
    expect(secondResult.chatId).toBe(createdChatId);

    // Chat activity cursor must NOT have advanced further (remains 4)
    const chat = await env.DB
      .prepare(`SELECT activity_cursor FROM chats WHERE id = ?`)
      .bind(createdChatId)
      .first<{ activity_cursor: number }>();
    expect(chat?.activity_cursor).toBe(4);

    // No duplicate system message was inserted
    const sysMsgCount = await env.DB
      .prepare(`SELECT COUNT(*) as count FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`)
      .bind(recordedRunId)
      .first<{ count: number }>();
    expect(sysMsgCount?.count).toBe(1);
  });

  it('rejects late write by removed workspace member via transaction guard', async () => {
    const lateUserId = 'usr_late_member';
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
       VALUES (?, 'fb_late', 'late@kerning.test', 'Late Member', ?, ?)`
    ).bind(lateUserId, now, now).run();

    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'member', ?, ?, ?)`
    ).bind(workspaceId, lateUserId, now, now, now).run();

    const lateToken = 'session_token_late_test';
    const lateTokenHash = await sha256(lateToken);
    await env.DB.prepare(
      `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
       VALUES ('sess_late', ?, ?, ?, ?, NULL, ?)`
    ).bind(lateTokenHash, lateUserId, now, expiresAt, now).run();
    const lateCookie = `${AUTH_BOUNDS.COOKIE_NAME}=${lateToken}`;

    // Create a chat for lateUserId
    const createChatRes = await SELF.fetch(
      `http://localhost/api/workspaces/${workspaceId}/chats`,
      {
        method: 'POST',
        headers: {
          cookie: lateCookie,
          origin: 'http://localhost',
          [AUTH_BOUNDS.CSRF_HEADER]: '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'Late Member Chat' }),
      },
    );
    expect(createChatRes.status).toBe(201);
    const chatData = (await createChatRes.json()) as { chat: Chat };
    const lateChatId = chatData.chat.id;

    // Now remove lateUserId from workspace_users
    await env.DB.prepare(
      `DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`
    ).bind(workspaceId, lateUserId).run();

    // Direct call to acceptWebMessage verifies that the transaction guard inside the D1 batch
    // rejects late writes if the caller was removed from workspace_users, even if an outer check passed.
    await expect(
      acceptWebMessage(env.DB, {
        workspaceId,
        chatId: lateChatId,
        userId: lateUserId,
        clientMessageId: 'late-member-direct-uuid',
        text: 'Posting directly after removal',
      }),
    ).rejects.toThrow(ForbiddenError);

    // Attempt to post message in lateChatId via HTTP route
    const postRes = await SELF.fetch(
      `http://localhost/api/workspaces/${workspaceId}/chats/${lateChatId}/messages`,
      {
        method: 'POST',
        headers: {
          cookie: lateCookie,
          origin: 'http://localhost',
          [AUTH_BOUNDS.CSRF_HEADER]: '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_message_id: 'late-member-msg-uuid',
          text: 'Posting after removal',
        }),
      },
    );

    // Route boundary rejects unauthenticated/non-member access
    expect([403, 404]).toContain(postRes.status);

    // Confirm nothing was written to messages_in or chat_messages
    const msgIn = await env.DB
      .prepare(`SELECT * FROM messages_in WHERE external_id IN ('late-member-msg-uuid', 'late-member-direct-uuid')`)
      .first();
    expect(msgIn).toBeNull();
  });

  it('paginates chats reliably across identical timestamps using composite cursor', async () => {
    // Relative to now: a fixed literal becomes a time bomb once wall-clock
    // passes it (ties flip from newest to oldest and the page math changes).
    const fixedTime = new Date(Date.now() + 3600 * 1000).toISOString();
    // Create 3 chats with exact identical last_activity_at
    const c1 = `chat_tie_1_${crypto.randomUUID().slice(0, 8)}`;
    const c2 = `chat_tie_2_${crypto.randomUUID().slice(0, 8)}`;
    const c3 = `chat_tie_3_${crypto.randomUUID().slice(0, 8)}`;

    for (const id of [c1, c2, c3]) {
      await env.DB.prepare(
        `INSERT INTO chats (id, workspace_id, author_user_id, title, activity_cursor, created_at, updated_at, last_activity_at)
         VALUES (?, ?, ?, 'Tie Chat', 0, ?, ?, ?)`
      ).bind(id, workspaceId, aviUserId, fixedTime, fixedTime, fixedTime).run();
    }

    // Request page 1 with limit=2
    const page1Res = await SELF.fetch(
      `http://localhost/api/workspaces/${workspaceId}/chats?limit=2`,
      { headers: { cookie: aviCookie } },
    );
    expect(page1Res.status).toBe(200);
    const page1Data = (await page1Res.json()) as { chats: Chat[]; next_cursor?: string };
    expect(page1Data.chats.length).toBe(2);
    expect(page1Data.next_cursor).toBeDefined();

    // Request page 2 using next_cursor
    const page2Res = await SELF.fetch(
      `http://localhost/api/workspaces/${workspaceId}/chats?limit=2&cursor=${encodeURIComponent(page1Data.next_cursor!)}`,
      { headers: { cookie: aviCookie } },
    );
    expect(page2Res.status).toBe(200);
    const page2Data = (await page2Res.json()) as { chats: Chat[]; next_cursor?: string };

    const allReturnedIds = [...page1Data.chats.map((c) => c.id), ...page2Data.chats.map((c) => c.id)];
    // Ensure all 3 tie chats are in the combined results and there are no duplicates
    for (const id of [c1, c2, c3]) {
      expect(allReturnedIds.filter((x) => x === id).length).toBe(1);
    }
  });

  describe('Telegram Webhook Inbound Routing', () => {
    it('rejects webhook requests with invalid secret token', async () => {
      const res = await SELF.fetch('http://localhost/api/inbound/telegram', {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': 'wrong_secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ update_id: 9999 }),
      });

      expect(res.status).toBe(401);
    });

    it('stores unlinked Telegram user messages as unrouted in messages_in', async () => {
      const res = await SELF.fetch('http://localhost/api/inbound/telegram', {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': 'test_webhook_secret_999',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          update_id: 2001,
          message: {
            message_id: 1,
            from: { id: 777001 },
            chat: { id: 777001, type: 'private' },
            date: 1700000000,
            text: 'Hello from unlinked Telegram user',
          },
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; reason: string };
      expect(data.status).toBe('unrouted');

      const msgIn = await env.DB
        .prepare(`SELECT * FROM messages_in WHERE external_id = 'test_bot:2001'`)
        .first<Record<string, unknown>>();
      expect(msgIn).toBeDefined();
      expect(msgIn!['status']).toBe('unrouted');
    });

    it('links Telegram user via /start <link_code> atomically', async () => {
      // Create a link code for Avi
      const linkCodeRaw = 'link_code_secret_xyz';
      const linkCodeHash = await sha256(linkCodeRaw);
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 600 * 1000).toISOString();

      await env.DB.prepare(
        `INSERT INTO link_codes (id, code_hash, user_id, created_at, expires_at, consumed_at)
         VALUES ('lc_test', ?, ?, ?, ?, NULL)`
      )
        .bind(linkCodeHash, aviUserId, now, expiresAt)
        .run();

      const res = await SELF.fetch('http://localhost/api/inbound/telegram', {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': 'test_webhook_secret_999',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          update_id: 2002,
          message: {
            message_id: 2,
            from: { id: 888002 },
            chat: { id: 888002, type: 'private' },
            date: 1700000000,
            text: `/start ${linkCodeRaw}`,
          },
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; user_id: string };
      expect(data.status).toBe('linked');
      expect(data.user_id).toBe(aviUserId);

      // Verify link_codes was consumed
      const lc = await env.DB
        .prepare(`SELECT consumed_at FROM link_codes WHERE id = 'lc_test'`)
        .first<{ consumed_at: string }>();
      expect(lc?.consumed_at).not.toBeNull();

      // Verify telegram_users mapping created
      const tgUser = await env.DB
        .prepare(`SELECT * FROM telegram_users WHERE telegram_user_id = '888002'`)
        .first<Record<string, unknown>>();
      expect(tgUser).toBeDefined();
      expect(tgUser!['user_id']).toBe(aviUserId);
      expect(tgUser!['selected_workspace_id']).toBe(workspaceId);
    });

    it('routes message from linked Telegram user into active workspace chat', async () => {
      const res = await SELF.fetch('http://localhost/api/inbound/telegram', {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': 'test_webhook_secret_999',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          update_id: 2003,
          message: {
            message_id: 3,
            from: { id: 888002 },
            chat: { id: 888002, type: 'private' },
            date: 1700000000,
            text: 'Telegram voice task check',
          },
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; run_id: string };
      expect(data.status).toBe('accepted');
      expect(data.run_id).toBeDefined();

      const run = await env.DB
        .prepare(`SELECT * FROM agent_runs WHERE id = ?`)
        .bind(data.run_id)
        .first<Record<string, unknown>>();
      expect(run).toBeDefined();
      expect(run!['workspace_id']).toBe(workspaceId);
    });

    it('handles unsupported photo with text by asking confirmation, without partial silent processing', async () => {
      const res = await SELF.fetch('http://localhost/api/inbound/telegram', {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': 'test_webhook_secret_999',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          update_id: 2004,
          message: {
            message_id: 4,
            from: { id: 888002 },
            chat: { id: 888002, type: 'private' },
            date: 1700000000,
            photo: [{ file_id: 'ph_999' }],
            caption: 'Here is the receipt for 500 euros',
          },
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string };
      expect(data.status).toBe('confirmation_required');

      // Verify pending clarification was persisted
      const clar = await env.DB
        .prepare(
          `SELECT * FROM pending_clarifications WHERE question LIKE '%Here is the receipt for 500 euros%'`
        )
        .first<Record<string, unknown>>();
      expect(clar).toBeDefined();
      expect(clar!['status']).toBe('pending');
      expect(clar!['intended_operation']).toBe('process_text_only');
    });

    it('disables endpoint (HTTP 503) when TELEGRAM_WEBHOOK_SECRET is not configured', async () => {
      const origSecret = env.TELEGRAM_WEBHOOK_SECRET;
      try {
        env.TELEGRAM_WEBHOOK_SECRET = '';
        const res = await SELF.fetch('http://localhost/api/inbound/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ update_id: 1111 }),
        });
        expect(res.status).toBe(503);
        const err = (await res.json()) as HttpErrorResponse;
        expect(err.error.code).toBe('service_unavailable');
      } finally {
        env.TELEGRAM_WEBHOOK_SECRET = origSecret;
      }
    });

    it('enforces single-use link codes under simultaneous concurrent redemptions', async () => {
      const linkCodeRaw = 'race_code_secret_456';
      const linkCodeHash = await sha256(linkCodeRaw);
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 600 * 1000).toISOString();

      await env.DB.prepare(
        `INSERT INTO link_codes (id, code_hash, user_id, created_at, expires_at, consumed_at)
         VALUES ('lc_race_test', ?, ?, ?, ?, NULL)`
      ).bind(linkCodeHash, hunorUserId, now, expiresAt).run();

      // Dispatch competing simultaneous redemption requests via Promise.all; database primary key and check constraints on link_redemptions enforce that at most one commits
      const [res1, res2] = await Promise.all([
        SELF.fetch('http://localhost/api/inbound/telegram', {
          method: 'POST',
          headers: {
            'x-telegram-bot-api-secret-token': 'test_webhook_secret_999',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            update_id: 3001,
            message: {
              message_id: 10,
              from: { id: 999001 },
              chat: { id: 999001, type: 'private' },
              date: 1700000000,
              text: `/start ${linkCodeRaw}`,
            },
          }),
        }),
        SELF.fetch('http://localhost/api/inbound/telegram', {
          method: 'POST',
          headers: {
            'x-telegram-bot-api-secret-token': 'test_webhook_secret_999',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            update_id: 3002,
            message: {
              message_id: 11,
              from: { id: 999002 },
              chat: { id: 999002, type: 'private' },
              date: 1700000000,
              text: `/start ${linkCodeRaw}`,
            },
          }),
        }),
      ]);

      const data1 = (await res1.json()) as { status: string; user_id?: string; reason?: string };
      const data2 = (await res2.json()) as { status: string; user_id?: string; reason?: string };

      const statuses = [data1.status, data2.status].sort();
      expect(statuses).toEqual(['linked', 'unrouted']);

      const linkedResult = data1.status === 'linked' ? data1 : data2;
      const unroutedResult = data1.status === 'unrouted' ? data1 : data2;

      expect(linkedResult.user_id).toBe(hunorUserId);
      expect(unroutedResult.reason).toBe('Invalid or expired link code');

      // Verify in DB: exactly ONE telegram user was linked
      const linkedUsers = await env.DB
        .prepare(`SELECT telegram_user_id FROM telegram_users WHERE telegram_user_id IN ('999001', '999002')`)
        .all<{ telegram_user_id: string }>();
      expect(linkedUsers.results?.length).toBe(1);

      // Verify link_redemptions has exactly one record
      const redemptions = await env.DB
        .prepare(`SELECT * FROM link_redemptions WHERE link_code_id = 'lc_race_test'`)
        .all();
      expect(redemptions.results?.length).toBe(1);

      // Verify that plaintext link code was REDACTED in messages_in.raw_payload
      const records = await env.DB
        .prepare(`SELECT raw_payload FROM messages_in WHERE external_id IN ('test_bot:3001', 'test_bot:3002')`)
        .all<{ raw_payload: string }>();

      expect(records.results?.length).toBe(2);
      for (const row of records.results || []) {
        expect(row.raw_payload).not.toContain(linkCodeRaw);
        expect(row.raw_payload).toContain('[REDACTED_LINK_CODE]');
      }
    });

    it('prevents already-linked account from treating /start or link codes as conversational text', async () => {
      const tgUserId = '888005';
      const now = new Date().toISOString();

      // Ensure 888005 is an already-linked account for aviUserId in workspaceId
      await env.DB.prepare(
        `INSERT INTO telegram_users (telegram_user_id, user_id, selected_workspace_id, active_chat_id, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?)`
      ).bind(tgUserId, aviUserId, workspaceId, now, now).run();

      // 1. Bare /start from an already-linked account
      const resBare = await SELF.fetch('http://localhost/api/inbound/telegram', {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': 'test_webhook_secret_999',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          update_id: 6001,
          message: {
            message_id: 61,
            from: { id: Number(tgUserId) },
            chat: { id: Number(tgUserId), type: 'private' },
            date: 1700000000,
            text: '/start',
          },
        }),
      });

      expect(resBare.status).toBe(200);
      const bareData = (await resBare.json()) as { status: string; reason?: string };
      expect(bareData.status).toBe('ignored');
      expect(bareData.reason).toBe('Already linked Telegram account');

      // 2. /start with valid re-link code from an already-linked account
      const relinkCodeRaw = 'relink_secret_code_789';
      const relinkCodeHash = await sha256(relinkCodeRaw);
      const expiresAt = new Date(Date.now() + 600 * 1000).toISOString();

      await env.DB.prepare(
        `INSERT INTO link_codes (id, code_hash, user_id, created_at, expires_at, consumed_at)
         VALUES ('lc_relink_test', ?, ?, ?, ?, NULL)`
      ).bind(relinkCodeHash, hunorUserId, now, expiresAt).run();

      const resRelink = await SELF.fetch('http://localhost/api/inbound/telegram', {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': 'test_webhook_secret_999',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          update_id: 6002,
          message: {
            message_id: 62,
            from: { id: Number(tgUserId) },
            chat: { id: Number(tgUserId), type: 'private' },
            date: 1700000000,
            text: `/start ${relinkCodeRaw}`,
          },
        }),
      });

      expect(resRelink.status).toBe(200);
      const relinkData = (await resRelink.json()) as { status: string; user_id?: string };
      expect(relinkData.status).toBe('linked');
      expect(relinkData.user_id).toBe(hunorUserId);

      // Verify telegram user mapping updated to hunorUserId
      const updatedTgUser = await env.DB
        .prepare(`SELECT user_id FROM telegram_users WHERE telegram_user_id = ?`)
        .bind(tgUserId)
        .first<{ user_id: string }>();
      expect(updatedTgUser?.user_id).toBe(hunorUserId);

      // 3. /start with invalid code from already-linked account
      const resInvalid = await SELF.fetch('http://localhost/api/inbound/telegram', {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': 'test_webhook_secret_999',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          update_id: 6003,
          message: {
            message_id: 63,
            from: { id: Number(tgUserId) },
            chat: { id: Number(tgUserId), type: 'private' },
            date: 1700000000,
            text: '/start invalid_code_999',
          },
        }),
      });

      expect(resInvalid.status).toBe(200);
      const invalidData = (await resInvalid.json()) as { status: string; reason?: string };
      expect(invalidData.status).toBe('unrouted');
      expect(invalidData.reason).toBe('Invalid or expired link code');

      // CRITICAL SECURITY ASSERTIONS:
      // Verify NO chat messages were created containing /start or any link codes
      const chatMessages = await env.DB
        .prepare(`SELECT COUNT(*) as count FROM chat_messages WHERE content_text LIKE '%/start%' OR content_text LIKE '%relink_secret_code%'`)
        .first<{ count: number }>();
      expect(chatMessages?.count).toBe(0);

      // Verify NO run activity was logged containing /start or any link codes
      const runActivities = await env.DB
        .prepare(`SELECT COUNT(*) as count FROM run_activity WHERE payload_json LIKE '%/start%' OR payload_json LIKE '%relink_secret_code%'`)
        .first<{ count: number }>();
      expect(runActivities?.count).toBe(0);

      // Verify NO agent runs were queued for any of the /start command messages
      const commandRuns = await env.DB
        .prepare(`SELECT COUNT(*) as count FROM agent_runs WHERE source_message_id IN (
          SELECT id FROM messages_in WHERE external_id IN ('test_bot:6001', 'test_bot:6002', 'test_bot:6003')
        )`)
        .first<{ count: number }>();
      expect(commandRuns?.count).toBe(0);

      // Verify raw payload has link code redacted
      const relinkMin = await env.DB
        .prepare(`SELECT raw_payload FROM messages_in WHERE external_id = 'test_bot:6002'`)
        .first<{ raw_payload: string }>();
      expect(relinkMin?.raw_payload).not.toContain(relinkCodeRaw);
      expect(relinkMin?.raw_payload).toContain('[REDACTED_LINK_CODE]');
    });

    it('keeps update unrouted without guessing when user has multiple workspace memberships', async () => {
      const multiUserId = 'usr_multi_ws';
      const wsA = 'ws-multi-a';
      const wsB = 'ws-multi-b';
      const now = new Date().toISOString();

      await env.DB.prepare(
        `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
         VALUES (?, 'fb_multi', 'multi@kerning.test', 'Multi User', ?, ?)`
      ).bind(multiUserId, now, now).run();

      for (const ws of [wsA, wsB]) {
        await env.DB.prepare(
          `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, last_acceptance_sequence, created_at, updated_at)
           VALUES (?, 'Multi WS', ?, 0, 1, 0, ?, ?)`
        ).bind(ws, multiUserId, now, now).run();

        await env.DB.prepare(
          `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
           VALUES (?, ?, 'owner', ?, ?, ?)`
        ).bind(ws, multiUserId, now, now, now).run();
      }

      // Link telegram user 555111 to multiUserId with no selected_workspace_id
      await env.DB.prepare(
        `INSERT INTO telegram_users (telegram_user_id, user_id, selected_workspace_id, active_chat_id, created_at, updated_at)
         VALUES ('555111', ?, NULL, NULL, ?, ?)`
      ).bind(multiUserId, now, now).run();

      const res = await SELF.fetch('http://localhost/api/inbound/telegram', {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': 'test_webhook_secret_999',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          update_id: 4001,
          message: {
            message_id: 20,
            from: { id: 555111 },
            chat: { id: 555111, type: 'private' },
            date: 1700000000,
            text: 'Hello to ambiguous workspace',
          },
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; reason: string };
      expect(data.status).toBe('unrouted');
      expect(data.reason).toBe('Multiple workspaces available; please select a workspace first');

      // Verify no chat message or agent run created in either workspace
      const chatMsg = await env.DB
        .prepare(`SELECT * FROM chat_messages WHERE content_text = 'Hello to ambiguous workspace'`)
        .first();
      expect(chatMsg).toBeNull();
    });

    it('rejects Telegram messages from removed workspace members as unrouted', async () => {
      // Create user and link to Telegram
      const removeUserId = 'usr_to_remove_tg';
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
         VALUES (?, 'fb_rm_tg', 'rm_tg@kerning.test', 'Remove TG User', ?, ?)`
      ).bind(removeUserId, now, now).run();

      await env.DB.prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
         VALUES (?, ?, 'member', ?, ?, ?)`
      ).bind(workspaceId, removeUserId, now, now, now).run();

      await env.DB.prepare(
        `INSERT INTO telegram_users (telegram_user_id, user_id, selected_workspace_id, active_chat_id, created_at, updated_at)
         VALUES ('777999', ?, ?, NULL, ?, ?)`
      ).bind(removeUserId, workspaceId, now, now).run();

      // Now remove user from workspace_users
      await env.DB.prepare(
        `DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`
      ).bind(workspaceId, removeUserId).run();

      // Attempt to send Telegram message
      const res = await SELF.fetch('http://localhost/api/inbound/telegram', {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': 'test_webhook_secret_999',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          update_id: 3003,
          message: {
            message_id: 12,
            from: { id: 777999 },
            chat: { id: 777999, type: 'private' },
            date: 1700000000,
            text: 'Should be rejected because user is removed',
          },
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; reason: string };
      expect(data.status).toBe('unrouted');
      expect(data.reason).toBe('User is not an active member of any workspace');

      // Verify no chat message was appended
      const chatMsg = await env.DB
        .prepare(`SELECT * FROM chat_messages WHERE content_text = 'Should be rejected because user is removed'`)
        .first();
      expect(chatMsg).toBeNull();
    });

    it('rejects inbound voice notes as unsupported without queuing agent runs', async () => {
      const res = await SELF.fetch('http://localhost/api/inbound/telegram', {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': 'test_webhook_secret_999',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          update_id: 3004,
          message: {
            message_id: 13,
            from: { id: 888002 },
            chat: { id: 888002, type: 'private' },
            date: 1700000000,
            voice: {
              file_id: 'voice_note_file_789',
              duration: 25,
            },
          },
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; reason: string };
      expect(data.status).toBe('unsupported');
      expect(data.reason).toContain('Voice notes are pending voice gate implementation (Gate 010)');

      // Verify in messages_in: status is unsupported
      const min = await env.DB
        .prepare(`SELECT * FROM messages_in WHERE external_id = 'test_bot:3004'`)
        .first<Record<string, unknown>>();
      expect(min).toBeDefined();
      expect(min!['status']).toBe('unsupported');
      expect(min!['error_message']).toContain('Gate 010');

      // Verify NO agent run was queued for this voice note
      const runs = await env.DB
        .prepare(`SELECT * FROM agent_runs WHERE source_message_id = ?`)
        .bind(min!['id'])
        .first();
      expect(runs).toBeNull();
    });

    it('propagates unexpected storage errors so webhook returns 500 to allow Telegram retries', async () => {
      // Create a DB wrapper that throws on batch
      const failingDb = {
        ...env.DB,
        prepare: (query: string) => {
          const stmt = env.DB.prepare(query);
          return stmt;
        },
        batch: async () => {
          throw new Error('D1 storage connection failure');
        },
      } as unknown as D1Database;

      // 1. In clean text message path, verify acceptTelegramInbound throws directly
      await expect(
        acceptTelegramInbound(failingDb, 'test_bot', {
          update_id: 5001,
          message: {
            message_id: 50,
            from: { id: 888002 },
            chat: { id: 888002, type: 'private' },
            date: 1700000000,
            text: 'Should fail with 500 retryable error on DB failure',
          },
        }),
      ).rejects.toThrow('D1 storage connection failure');

      // 2. Verify handleTelegramWebhook maps thrown storage error to HTTP 500 Response
      const req = new Request('http://localhost/api/inbound/telegram', {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': 'test_webhook_secret_999',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          update_id: 5001,
          message: {
            message_id: 50,
            from: { id: 888002 },
            chat: { id: 888002, type: 'private' },
            date: 1700000000,
            text: 'Should fail with 500 retryable error on DB failure',
          },
        }),
      });

      const res = await handleTelegramWebhook(req, { ...env, DB: failingDb }, 'req_storage_fail_test');
      expect(res.status).toBe(500);
      const data = (await res.json()) as HttpErrorResponse;
      expect(data.error.code).toBe('internal_error');
      expect(data.error.message).toContain('D1 storage connection failure');
    });
  });
});

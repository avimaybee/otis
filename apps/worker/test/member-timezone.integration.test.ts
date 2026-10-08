import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
import { AUTH_BOUNDS } from '@otis/contracts';
import { createChat } from '../src/inbox/repository.js';
import { getTurnContext } from '../src/agent/context.js';
import { sha256 } from '@otis/identity';

/**
 * Member interpretation timezone on workerd D1: the web client reports its
 * IANA zone with each message, the server stores it apart from the brief
 * schedule, and turn context resolves relative dates in that zone with the
 * brief zone as fallback and honest unknown otherwise.
 */

const CSRF = {
  origin: 'http://localhost',
  [AUTH_BOUNDS.CSRF_HEADER]: '1',
  'Content-Type': 'application/json',
};

const WS = 'ws-member-tz';
const OWNER = 'usr_tz_owner';

let ownerCookie = '';
let chatId = '';

async function send(text: string, clientMessageId: string, timezone?: string): Promise<Response> {
  return SELF.fetch(`http://localhost/api/workspaces/${WS}/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { Cookie: ownerCookie, ...CSRF },
    body: JSON.stringify({
      client_message_id: clientMessageId,
      text,
      ...(timezone !== undefined ? { timezone } : {}),
    }),
  });
}

async function storedZone(): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT interpretation_timezone FROM member_settings WHERE workspace_id = ? AND user_id = ?`,
  ).bind(WS, OWNER).first<{ interpretation_timezone: string | null }>();
  return row?.interpretation_timezone ?? null;
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
     VALUES (?, 'fb_tz_owner', 'owner@tz.test', 'Owner', ?, ?)`,
  ).bind(OWNER, now, now).run();
  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
     VALUES (?, 'TZ Shop', ?, 0, 1, ?, ?)`,
  ).bind(WS, OWNER, now, now).run();
  await env.DB.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?, ?)`,
  ).bind(WS, OWNER, now, now, now).run();
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
     VALUES ('sess_tz_owner', ?, ?, ?, ?, NULL, ?)`,
  ).bind(await sha256('tok_tz_owner'), OWNER, now, expiresAt, now).run();
  ownerCookie = `${AUTH_BOUNDS.COOKIE_NAME}=tok_tz_owner`;
  chatId = (await createChat(env.DB, { workspaceId: WS, authorUserId: OWNER, title: 'TZ flow' })).id;
});

describe('member interpretation timezone', () => {
  it('stores the reported zone and resolves turn context in it', async () => {
    const res = await send('Meeting tomorrow in Cluj', 'cm-tz-1', 'Europe/Bucharest');
    expect(res.status).toBe(202);
    expect(await storedZone()).toBe('Europe/Bucharest');

    const context = await getTurnContext(env.DB, {
      workspaceId: WS,
      actorUserId: OWNER,
      chatId,
      sourceText: 'Meeting tomorrow in Cluj',
    });
    expect(context.systemPrompt).toContain('(Europe/Bucharest)');
    expect(context.systemPrompt).not.toContain('Timezone: unknown');
  });

  it('keeps the stored zone when later messages omit it, and rejects invalid zones', async () => {
    const res = await send('Any update?', 'cm-tz-2');
    expect(res.status).toBe(202);
    expect(await storedZone()).toBe('Europe/Bucharest');

    const bad = await send('Hello?', 'cm-tz-3', 'Not/AZone');
    expect(bad.status).toBe(422);
    expect(await storedZone()).toBe('Europe/Bucharest');
  });

  it('falls back to the brief zone and stays honest when nothing is known', async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE member_settings SET interpretation_timezone = NULL, brief_timezone = 'Europe/Budapest', updated_at = ?
       WHERE workspace_id = ? AND user_id = ?`,
    ).bind(now, WS, OWNER).run();
    const context = await getTurnContext(env.DB, {
      workspaceId: WS, actorUserId: OWNER, chatId, sourceText: 'hi',
    });
    expect(context.systemPrompt).toContain('(Europe/Budapest)');

    await env.DB.prepare(
      `UPDATE member_settings SET brief_timezone = NULL, updated_at = ? WHERE workspace_id = ? AND user_id = ?`,
    ).bind(now, WS, OWNER).run();
    const unknown = await getTurnContext(env.DB, {
      workspaceId: WS, actorUserId: OWNER, chatId, sourceText: 'hi',
    });
    expect(unknown.systemPrompt).toContain('Timezone: unknown');
  });
});

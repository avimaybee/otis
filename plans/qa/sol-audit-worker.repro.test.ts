/** Defect reproduction using actual local Workers/D1; no remote data/providers. */
import { expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { sha256 } from '../../packages/identity/src/index.js';
import { applyMigrations } from '../../apps/worker/test/migrations.js';
import { createChat } from '../../apps/worker/src/inbox/repository.js';
import { createActivityStream } from '../../apps/worker/src/chat/stream.js';
import { liveChatBus } from '../../apps/worker/src/chat/liveBus.js';

it('default production stream receives a private broadcast after D1 membership removal', async () => {
  await applyMigrations(env.DB);
  const userId = 'audit-stream-user';
  const workspaceId = 'audit-stream-workspace';
  const rawToken = 'audit-synthetic-session';
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(userId, 'audit-stream-firebase', 'audit@example.test', 'Audit synthetic member', now, now),
    env.DB.prepare(`INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at) VALUES (?, 'Audit synthetic workspace', ?, 0, 1, ?, ?)`).bind(workspaceId, userId, now, now),
    env.DB.prepare(`INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)`).bind(workspaceId, userId, now, now, now),
    env.DB.prepare(`INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at) VALUES ('audit-stream-session', ?, ?, ?, ?, NULL, ?)`).bind(await sha256(rawToken), userId, now, new Date(Date.now() + 3600000).toISOString(), now),
  ]);
  const chat = await createChat(env.DB, { workspaceId, authorUserId: userId });
  const response = createActivityStream(env.DB, { workspaceId, chatId: chat.id, userId, sessionToken: rawToken, heartbeatMs: 10, maxStreamMs: 2000, afterCursor: 0 });
  const reader = response.body!.getReader();
  try {
    await vi.waitFor(() => expect(liveChatBus.listenerCount(workspaceId, chat.id)).toBe(1), { timeout: 1000, interval: 10 });
    await env.DB.prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`).bind(workspaceId, userId).run();
    // Synthetic producer event: this tests the authorized subscription boundary,
    // not persistence/fencing or multi-isolate delivery of the agent producer.
    liveChatBus.broadcast(workspaceId, chat.id, { name: 'activity', data: { marker: 'private-after-removal' }, id: 1 });
    let body = '';
    const decoder = new TextDecoder();
    for (let index = 0; index < 20 && !body.includes('private-after-removal'); index++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value);
    }
    expect(body).toContain('private-after-removal');
  } finally {
    await reader.cancel();
  }
});

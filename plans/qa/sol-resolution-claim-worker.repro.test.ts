/** Actual local D1 probes; no remote providers. Green confirms observations. */
import { beforeAll, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { sha256 } from '../../packages/identity/src/index.js';
import { applyMigrations } from '../../apps/worker/test/migrations.js';
import { createChat } from '../../apps/worker/src/inbox/repository.js';
import { createActivityStream } from '../../apps/worker/src/chat/stream.js';
import { liveChatBus } from '../../apps/worker/src/chat/liveBus.js';
import { publishAgentActivity } from '../../apps/worker/src/agent/activity.js';
import type { TurnContext } from '../../apps/worker/src/actor/dispatch.js';

beforeAll(async () => { await applyMigrations(env.DB); });
let seedCount = 0;
async function seed() {
  const suffix = String(++seedCount);
  const userId = `claim-audit-user-${suffix}`;
  const workspaceId = `claim-audit-workspace-${suffix}`;
  const rawToken = `claim-audit-synthetic-session-${suffix}`;
  const sessionId = `claim-audit-session-${suffix}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(userId, `claim-audit-firebase-${suffix}`, `claim-audit-${suffix}@example.test`, 'Synthetic audit member', now, now),
    env.DB.prepare(`INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at) VALUES (?, 'Synthetic claim audit', ?, 0, 1, ?, ?)`).bind(workspaceId, userId, now, now),
    env.DB.prepare(`INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)`).bind(workspaceId, userId, now, now, now),
    env.DB.prepare(`INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at) VALUES (?, ?, ?, ?, ?, NULL, ?)`).bind(sessionId, await sha256(rawToken), userId, now, new Date(Date.now() + 3600000).toISOString(), now),
  ]);
  const chat = await createChat(env.DB, { workspaceId, authorUserId: userId });
  return { userId, workspaceId, rawToken, sessionId, now, chat };
}

it('cancelled stale executor can still persist and publish new activity with a positive cursor', async () => {
  const { workspaceId, now, chat } = await seed();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO system_jobs (id, workspace_id, job_kind, status, scheduled_at, created_at, updated_at) VALUES ('claim-audit-job', ?, 'scheduled_daily_brief', 'succeeded', ?, ?, ?)`).bind(workspaceId, now, now, now),
    env.DB.prepare(`INSERT INTO agent_runs (id, workspace_id, chat_id, source_job_id, executor_kind, status, attempt_id, lease_fence, created_at, updated_at) VALUES ('claim-audit-run', ?, ?, 'claim-audit-job', 'system', 'cancelled', 'new-attempt', 2, ?, ?)`).bind(workspaceId, chat.id, now, now),
  ]);
  const events: unknown[] = [];
  const unsubscribe = liveChatBus.subscribe(workspaceId, chat.id, event => { events.push(event); });
  try {
    const ctx = { db: env.DB, workspaceId, chatId: chat.id, runId: 'claim-audit-run', attemptId: 'old-attempt', fence: 1 } as TurnContext;
    await publishAgentActivity(ctx, 'stale-text', 'text_chunk', { text: 'after cancellation' });
    const row = await env.DB.prepare(`SELECT cursor, payload_json FROM run_activity WHERE run_id = 'claim-audit-run'`).first<{cursor:number; payload_json:string}>();
    expect(row?.cursor).toBeGreaterThan(0);
    expect(row?.payload_json).toContain('after cancellation');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: row!.cursor, data: { cursor: row!.cursor } });
    await publishAgentActivity(ctx, 'stale-text', 'text_chunk', { text: 'after cancellation' });
    expect(events).toHaveLength(1);
  } finally { unsubscribe(); }
});

it('freshly revoked session still receives an in-memory event through the cached session', async () => {
  const { userId, workspaceId, rawToken, sessionId, now, chat } = await seed();
  const response = createActivityStream(env.DB, { workspaceId, chatId: chat.id, userId, sessionToken: rawToken, heartbeatMs: 10, maxStreamMs: 2000, afterCursor: 0 });
  const reader = response.body!.getReader();
  try {
    await vi.waitFor(() => expect(liveChatBus.listenerCount(workspaceId, chat.id)).toBe(1), { timeout:1000, interval:10 });
    await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`).bind(now,sessionId).run();
    liveChatBus.broadcast(workspaceId, chat.id, { name:'activity', id:1, data:{marker:'private-after-session-revocation'} });
    let body = '';
    const decoder = new TextDecoder();
    for (let i=0; i<20 && !body.includes('private-after-session-revocation'); i++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value);
    }
    expect(body).toContain('private-after-session-revocation');
    expect(body).not.toContain('membership_revoked');
  } finally { await reader.cancel(); }
});

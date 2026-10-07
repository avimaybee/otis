import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
// @ts-expect-error vite raw import
import migration0001Sql from '../../../migrations/0001_identity.sql?raw';
// @ts-expect-error vite raw import
import migration0002Sql from '../../../migrations/0002_conversations_sources.sql?raw';
import { publishAgentActivity } from '../src/agent/activity.js';
import type { TurnContext } from '../src/actor/dispatch.js';
import { liveChatBus, type ChatStreamEvent } from '../src/chat/liveBus.js';

/**
 * R02 stale-publisher guard: public activity commits only while its turn
 * still owns the run (current attempt, live lease/fence, member author).
 * A stale frame inserts nothing, burns no cursor, and broadcasts nothing.
 * Real local D1 through the production batch; the bus subscriber proves the
 * publication half of "persisted before publication" both ways.
 */

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  for (const rawLine of sql.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('--') || line.length === 0) continue;
    current += rawLine + '\n';
    if (line.endsWith(';')) {
      statements.push(current.trim());
      current = '';
    }
  }
  if (current.trim().length > 0) statements.push(current.trim());
  return statements;
}

const ATT = 'att_live';
const FENCE = 1;
const future = new Date(Date.now() + 3600_000).toISOString();

interface Seed {
  ws: string;
  chat: string;
  run: string;
  user: string;
  msg: string | null;
}

async function seedMemberRun(tag: string): Promise<Seed> {
  const now = new Date().toISOString();
  const ws = `ws-act-${tag}`;
  const user = `usr-act-${tag}`;
  const chat = `chat-act-${tag}`;
  const run = `run-act-${tag}`;
  const msg = `min-act-${tag}`;
  await env.DB.prepare(
    `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(user, `fb-act-${tag}`, `${tag}@kerning.test`, 'Avi', now, now).run();
  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
     VALUES (?, 'Guard WS', ?, 0, 1, ?, ?)`,
  ).bind(ws, user, now, now).run();
  await env.DB.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?, ?)`,
  ).bind(ws, user, now, now, now).run();
  await env.DB.prepare(
    `INSERT INTO chats (id, workspace_id, author_user_id, title, is_archived, activity_cursor, created_at, updated_at, last_activity_at)
     VALUES (?, ?, ?, 'Guard chat', 0, 0, ?, ?, ?)`,
  ).bind(chat, ws, user, now, now, now).run();
  await env.DB.prepare(
    `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, chat_id, created_at, updated_at)
     VALUES (?, ?, ?, 'web', ?, ?, ?, 'processed', ?, ?, ?)`,
  ).bind(msg, ws, user, `ext-act-${tag}`, `fp-act-${tag}`, '{}', chat, now, now).run();
  await env.DB.prepare(
    `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, source_job_id, executor_kind, status, attempt_id, lease_fence, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 'agent', 'running', ?, ?, ?, ?)`,
  ).bind(run, ws, chat, msg, ATT, FENCE, now, now).run();
  await env.DB.prepare(
    `UPDATE workspaces SET lease_owner = ?, lease_attempt_id = ?, lease_fence = ?, lease_expires_at = ? WHERE id = ?`,
  ).bind(ATT, ATT, FENCE, future, ws).run();
  return { ws, chat, run, user, msg };
}

function ctxFor(seed: Seed, overrides?: Partial<TurnContext>): TurnContext {
  return {
    db: env.DB,
    workspaceId: seed.ws,
    runId: seed.run,
    attemptId: ATT,
    fence: FENCE,
    chatId: seed.chat,
    sourceMessageId: seed.msg,
    sourceJobId: null,
    sourceText: 'field note',
    channel: 'web',
    answerText: null,
    answerMessageId: null,
    ...overrides,
  };
}

async function activityCount(seed: Seed): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM run_activity WHERE workspace_id = ?`)
    .bind(seed.ws).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function chatCursor(seed: Seed): Promise<number> {
  const row = await env.DB.prepare(`SELECT activity_cursor AS c FROM chats WHERE id = ?`)
    .bind(seed.chat).first<{ c: number }>();
  return Number(row?.c ?? -1);
}

describe('publishAgentActivity holder guard', () => {
  beforeAll(async () => {
    for (const sql of [migration0001Sql, migration0002Sql]) {
      for (const stmt of splitSqlStatements(sql)) {
        await env.DB.prepare(stmt).run();
      }
    }
  });

  it('publishes while the turn holds the run, then stays idempotent on retry', async () => {
    const seed = await seedMemberRun('happy');
    const seen: ChatStreamEvent[] = [];
    const off = liveChatBus.subscribe(seed.ws, seed.chat, (event) => { seen.push(event); });
    try {
      await publishAgentActivity(ctxFor(seed), 'step0_started', 'step_started', { tool_name: 'save_note' });
      expect(await activityCount(seed)).toBe(1);
      expect(await chatCursor(seed)).toBe(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.data.cursor).toBe(1);

      // Retried publish with the same key: no second row, no cursor burn, no rebroadcast.
      await publishAgentActivity(ctxFor(seed), 'step0_started', 'step_started', { tool_name: 'save_note' });
      expect(await activityCount(seed)).toBe(1);
      expect(await chatCursor(seed)).toBe(1);
      expect(seen).toHaveLength(1);
    } finally {
      off();
    }
  });

  it('refuses a frame from a superseded attempt', async () => {
    const seed = await seedMemberRun('stale');
    const seen: ChatStreamEvent[] = [];
    const off = liveChatBus.subscribe(seed.ws, seed.chat, (event) => { seen.push(event); });
    try {
      await publishAgentActivity(ctxFor(seed, { attemptId: 'att_old', fence: 0 }), 'step0_started', 'step_started', {});
      expect(await activityCount(seed)).toBe(0);
      expect(await chatCursor(seed)).toBe(0);
      expect(seen).toHaveLength(0);
    } finally {
      off();
    }
  });

  it('refuses after the run moved on to a newer attempt', async () => {
    const seed = await seedMemberRun('moved');
    await env.DB.prepare(`UPDATE agent_runs SET attempt_id = 'att_new', lease_fence = 2 WHERE id = ?`)
      .bind(seed.run).run();
    await env.DB.prepare(
      `UPDATE workspaces SET lease_owner = 'att_new', lease_attempt_id = 'att_new', lease_fence = 2, lease_expires_at = ? WHERE id = ?`,
    ).bind(future, seed.ws).run();
    const seen: ChatStreamEvent[] = [];
    const off = liveChatBus.subscribe(seed.ws, seed.chat, (event) => { seen.push(event); });
    try {
      await publishAgentActivity(ctxFor(seed), 'step0_started', 'step_started', {});
      expect(await activityCount(seed)).toBe(0);
      expect(await chatCursor(seed)).toBe(0);
      expect(seen).toHaveLength(0);
    } finally {
      off();
    }
  });

  it('refuses once the run is terminal', async () => {
    const seed = await seedMemberRun('terminal');
    await env.DB.prepare(`UPDATE agent_runs SET status = 'cancelled' WHERE id = ?`).bind(seed.run).run();
    const seen: ChatStreamEvent[] = [];
    const off = liveChatBus.subscribe(seed.ws, seed.chat, (event) => { seen.push(event); });
    try {
      await publishAgentActivity(ctxFor(seed), 'step0_finished', 'step_finished', {});
      expect(await activityCount(seed)).toBe(0);
      expect(await chatCursor(seed)).toBe(0);
      expect(seen).toHaveLength(0);
    } finally {
      off();
    }
  });

  it('refuses on an expired lease', async () => {
    const seed = await seedMemberRun('expired');
    await env.DB.prepare(`UPDATE workspaces SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`)
      .bind(seed.ws).run();
    const seen: ChatStreamEvent[] = [];
    const off = liveChatBus.subscribe(seed.ws, seed.chat, (event) => { seen.push(event); });
    try {
      await publishAgentActivity(ctxFor(seed), 'step0_started', 'step_started', {});
      expect(await activityCount(seed)).toBe(0);
      expect(await chatCursor(seed)).toBe(0);
      expect(seen).toHaveLength(0);
    } finally {
      off();
    }
  });

  it('refuses after the author lost membership', async () => {
    const seed = await seedMemberRun('removed');
    await env.DB.prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .bind(seed.ws, seed.user).run();
    const seen: ChatStreamEvent[] = [];
    const off = liveChatBus.subscribe(seed.ws, seed.chat, (event) => { seen.push(event); });
    try {
      await publishAgentActivity(ctxFor(seed), 'step0_started', 'step_started', {});
      expect(await activityCount(seed)).toBe(0);
      expect(await chatCursor(seed)).toBe(0);
      expect(seen).toHaveLength(0);
    } finally {
      off();
    }
  });

  it('refuses late frames once the turn is aborted', async () => {
    const seed = await seedMemberRun('aborted');
    const controller = new AbortController();
    controller.abort();
    const seen: ChatStreamEvent[] = [];
    const off = liveChatBus.subscribe(seed.ws, seed.chat, (event) => { seen.push(event); });
    try {
      await publishAgentActivity(ctxFor(seed, { signal: controller.signal }), 'step0_started', 'step_started', {});
      expect(await activityCount(seed)).toBe(0);
      expect(await chatCursor(seed)).toBe(0);
      expect(seen).toHaveLength(0);
    } finally {
      off();
    }
  });

  it('publishes system-job frames while the job is live, not after it settles', async () => {
    const now = new Date().toISOString();
    const ws = 'ws-act-sys';
    const chat = 'chat-act-sys';
    const run = 'run-act-sys';
    const job = 'job-act-sys';
    const user = 'usr-act-sys';
    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(user, 'fb-act-sys', 'sys@kerning.test', 'Avi', now, now).run();
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
       VALUES (?, 'Sys WS', ?, 0, 1, ?, ?)`,
    ).bind(ws, user, now, now).run();
    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'owner', ?, ?, ?)`,
    ).bind(ws, user, now, now, now).run();
    await env.DB.prepare(
      `INSERT INTO chats (id, workspace_id, author_user_id, title, is_archived, activity_cursor, created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, 'Sys chat', 0, 0, ?, ?, ?)`,
    ).bind(chat, ws, user, now, now, now).run();
    await env.DB.prepare(
      `INSERT INTO system_jobs (id, workspace_id, job_kind, status, scheduled_at, created_at, updated_at)
       VALUES (?, ?, 'summary_refresh', 'running', ?, ?, ?)`,
    ).bind(job, ws, now, now, now).run();
    await env.DB.prepare(
      `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, source_job_id, executor_kind, status, attempt_id, lease_fence, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, 'system', 'running', ?, ?, ?, ?)`,
    ).bind(run, ws, chat, job, ATT, FENCE, now, now).run();
    await env.DB.prepare(
      `UPDATE workspaces SET lease_owner = ?, lease_attempt_id = ?, lease_fence = ?, lease_expires_at = ? WHERE id = ?`,
    ).bind(ATT, ATT, FENCE, future, ws).run();

    const seed: Seed = { ws, chat, run, user, msg: null };
    const seen: ChatStreamEvent[] = [];
    const off = liveChatBus.subscribe(ws, chat, (event) => { seen.push(event); });
    try {
      await publishAgentActivity(ctxFor(seed), 'job_tick', 'run_started', {});
      expect(await activityCount(seed)).toBe(1);
      expect(seen).toHaveLength(1);

      // Settled jobs lose publication authority with the run.
      await env.DB.prepare(`UPDATE system_jobs SET status = 'succeeded' WHERE id = ?`).bind(job).run();
      await publishAgentActivity(ctxFor(seed), 'job_tick2', 'run_started', {});
      expect(await activityCount(seed)).toBe(1);
      expect(await chatCursor(seed)).toBe(1);
      expect(seen).toHaveLength(1);
    } finally {
      off();
    }
  });
});

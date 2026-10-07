import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
import {
  cancelReminder,
  createReminder,
  processDueReminders,
  updateReminder,
} from '../src/reminders/service.js';
import { deliverTelegramOutbox } from '../src/inbox/telegramDelivery.js';
import { executeAgentTool } from '../src/agent/repository.js';

/**
 * R08 one-off reminders: confirmed create/change/cancel plus the due sweep
 * delivering through the existing chat and Telegram owners. Real local D1;
 * no live sends (Telegram delivery is asserted at the intent-row shape the
 * existing consumer revalidates). Each test owns an isolated workspace so
 * sweep tallies never overlap.
 */

const AVI = 'usr_rem_avi';
const HUNOR = 'usr_rem_hunor';
const NOW = '2026-10-06T12:00:00.000Z';
const FUTURE = '2026-10-06T15:00:00.000Z';
const PAST = '2026-10-06T09:00:00.000Z';

async function count(table: string, where = '', ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`,
  ).bind(...binds).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  for (const [id, fb, email, name] of [
    [AVI, 'fb_rem_avi', 'avi@rem.test', 'Avi'],
    [HUNOR, 'fb_rem_hunor', 'hunor@rem.test', 'Hunor'],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(id, fb, email, name, NOW, NOW).run();
  }
});

/** Isolated workspace+member+chat per test so sweep tallies never overlap. */
let scopeSeq = 0;
async function newScope(tag: string, owner = AVI): Promise<{ ws: string; user: string; chat: string }> {
  scopeSeq += 1;
  const ws = `ws-rem-${tag}-${scopeSeq}`;
  const chat = `chat-rem-${tag}-${scopeSeq}`;
  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, ?, ?)`,
  ).bind(ws, `Reminders ${tag}`, owner, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?, ?)`,
  ).bind(ws, owner, NOW, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO chats (id, workspace_id, author_user_id, title, is_archived, activity_cursor, created_at, updated_at, last_activity_at)
     VALUES (?, ?, ?, 'Scope chat', 0, 0, ?, ?, ?)`,
  ).bind(chat, ws, owner, NOW, NOW, NOW).run();
  return { ws, user: owner, chat };
}

async function addMember(ws: string, user: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, 'member', ?, ?, ?)`,
  ).bind(ws, user, NOW, NOW, NOW).run();
}

describe('one-off reminders', () => {
  it('creates, dedupes by action identity, and refuses non-members and past times', async () => {
    const { ws, user, chat } = await newScope('create');
    const first = await createReminder(env.DB, {
      workspaceId: ws,
      userId: user,
      chatId: chat,
      actionId: 'act-rem-1',
      text: 'Call the bakery',
      at: FUTURE,
      nowIso: NOW,
    });
    expect(first.status).toBe('created');
    if (first.status !== 'created') throw new Error('expected created');

    // Retried tool call with the same action identity replays the row.
    const replay = await createReminder(env.DB, {
      workspaceId: ws,
      userId: user,
      chatId: chat,
      actionId: 'act-rem-1',
      text: 'Call the bakery',
      at: FUTURE,
      nowIso: NOW,
    });
    expect(replay.status).toBe('already');
    if (replay.status !== 'already') throw new Error('expected already');
    expect(replay.reminder.id).toBe(first.reminder.id);
    expect(await count('reminders', 'workspace_id = ?', ws)).toBe(1);

    const outsider = await createReminder(env.DB, {
      workspaceId: ws,
      userId: 'usr_rem_ghost',
      actionId: 'act-rem-ghost',
      text: 'Nope',
      at: FUTURE,
      nowIso: NOW,
    });
    expect(outsider).toEqual(expect.objectContaining({ status: 'rejected', code: 'not_member' }));

    const past = await createReminder(env.DB, {
      workspaceId: ws,
      userId: user,
      actionId: 'act-rem-past',
      text: 'Too late',
      at: PAST,
      nowIso: NOW,
    });
    expect(past).toEqual(expect.objectContaining({ status: 'rejected', code: 'invalid_time' }));
  });

  it('changes pending reminders and refuses settled or foreign ones', async () => {
    const { ws, user } = await newScope('change');
    const created = await createReminder(env.DB, {
      workspaceId: ws,
      userId: user,
      actionId: 'act-rem-change',
      text: 'Original text',
      at: FUTURE,
      nowIso: NOW,
    });
    if (created.status !== 'created') throw new Error('expected created');

    const updated = await updateReminder(env.DB, {
      workspaceId: ws,
      userId: user,
      reminderId: created.reminder.id,
      text: 'Changed text',
      at: '2026-10-06T16:00:00.000Z',
      nowIso: NOW,
    });
    expect(updated.status).toBe('updated');
    if (updated.status !== 'updated') throw new Error('expected updated');
    expect(updated.reminder.text).toBe('Changed text');

    // Another member's id reads as not found, never as forbidden.
    await addMember(ws, HUNOR);
    const foreign = await updateReminder(env.DB, {
      workspaceId: ws,
      userId: HUNOR,
      reminderId: created.reminder.id,
      text: 'Hijacked',
      nowIso: NOW,
    });
    expect(foreign).toEqual(expect.objectContaining({ status: 'rejected', code: 'not_found' }));

    await cancelReminder(env.DB, { workspaceId: ws, userId: user, reminderId: created.reminder.id, nowIso: NOW });
    const settled = await updateReminder(env.DB, {
      workspaceId: ws,
      userId: user,
      reminderId: created.reminder.id,
      text: 'Too late',
      nowIso: NOW,
    });
    expect(settled).toEqual(expect.objectContaining({ status: 'rejected', code: 'settled' }));
  });

  it('cancels pending reminders exactly once and never delivers them', async () => {
    const { ws, user } = await newScope('cancel');
    const created = await createReminder(env.DB, {
      workspaceId: ws,
      userId: user,
      actionId: 'act-rem-cancel',
      text: 'Never mind',
      at: FUTURE,
      nowIso: NOW,
    });
    if (created.status !== 'created') throw new Error('expected created');

    const cancelled = await cancelReminder(env.DB, {
      workspaceId: ws,
      userId: user,
      reminderId: created.reminder.id,
      nowIso: NOW,
    });
    expect(cancelled.status).toBe('cancelled');

    const again = await cancelReminder(env.DB, {
      workspaceId: ws,
      userId: user,
      reminderId: created.reminder.id,
      nowIso: NOW,
    });
    expect(again.status).toBe('already');

    const missing = await cancelReminder(env.DB, {
      workspaceId: ws,
      userId: user,
      reminderId: 'rem_missing',
      nowIso: NOW,
    });
    expect(missing).toEqual(expect.objectContaining({ status: 'rejected', code: 'not_found' }));

    // A cancelled reminder never fires, even past its instant. The sweep may
    // deliver other scopes' due reminders; this row stays silent.
    await processDueReminders(env.DB, '2026-10-07T12:00:00.000Z', { limit: 100 });
    expect(await count('chat_messages', `content_text LIKE '⏰ Reminder: Never mind%'`)).toBe(0);
    const row = await env.DB.prepare(`SELECT status FROM reminders WHERE id = ?`)
      .bind(created.reminder.id).first<{ status: string }>();
    expect(row?.status).toBe('cancelled');
  });

  it('delivers due web reminders once with a canonical message and activity', async () => {
    const { ws, user, chat } = await newScope('web');
    const created = await createReminder(env.DB, {
      workspaceId: ws,
      userId: user,
      chatId: chat,
      actionId: 'act-rem-web',
      text: 'Water the plants',
      at: '2026-10-06T13:00:00.000Z',
      nowIso: NOW,
    });
    if (created.status !== 'created') throw new Error('expected created');

    // Future instant: the sweep stays silent.
    const early = await processDueReminders(env.DB, NOW);
    expect(early.delivered).toBe(0);

    const swept = await processDueReminders(env.DB, '2026-10-06T14:00:00.000Z');
    expect(swept).toEqual({ delivered: 1, cancelled: 0, failed: 0 });

    const body = await env.DB.prepare(`SELECT content_text, author_kind, channel FROM chat_messages WHERE id = ?`)
      .bind(`msg_rem_${created.reminder.id}`).first<Record<string, unknown>>();
    expect(body?.['content_text']).toBe('⏰ Reminder: Water the plants');
    expect(body?.['author_kind']).toBe('system');
    const activity = await env.DB.prepare(
      `SELECT type, payload_json FROM run_activity WHERE id = ?`,
    ).bind(`act_rem_${created.reminder.id}`).first<Record<string, unknown>>();
    expect(activity?.['type']).toBe('answer_saved');
    expect(String(activity?.['payload_json'])).toContain(created.reminder.id);

    // A second sweep repairs only the marker: still exactly one message.
    // (The sweep may deliver other scopes' reminders due by then.)
    await processDueReminders(env.DB, '2026-10-06T15:00:00.000Z');
    expect(await count('chat_messages', 'id = ?', `msg_rem_${created.reminder.id}`)).toBe(1);
    const row = await env.DB.prepare(`SELECT status FROM reminders WHERE id = ?`)
      .bind(created.reminder.id).first<{ status: string }>();
    expect(row?.status).toBe('sent');
  });

  it('delivers exactly once under concurrent sweeps', async () => {
    const { ws, user, chat } = await newScope('race');
    const created = await createReminder(env.DB, {
      workspaceId: ws,
      userId: user,
      chatId: chat,
      actionId: 'act-rem-race',
      text: 'Race the sweep',
      at: '2026-10-06T13:00:00.000Z',
      nowIso: NOW,
    });
    if (created.status !== 'created') throw new Error('expected created');

    const [first, second] = await Promise.all([
      processDueReminders(env.DB, '2026-10-06T14:00:00.000Z'),
      processDueReminders(env.DB, '2026-10-06T14:00:00.000Z'),
    ]);
    // Both sweeps report progress, but exactly one message and one activity
    // ever persist: the deterministic ids collapse the loser into the sent
    // marker instead of duplicating the delivery.
    expect(first.delivered + second.delivered).toBeGreaterThanOrEqual(1);
    expect(await count('chat_messages', 'id = ?', `msg_rem_${created.reminder.id}`)).toBe(1);
    expect(await count('run_activity', 'id = ?', `act_rem_${created.reminder.id}`)).toBe(1);
  });

  it('auto-cancels reminders whose member left instead of delivering', async () => {
    const { ws, user } = await newScope('left', HUNOR);
    const created = await createReminder(env.DB, {
      workspaceId: ws,
      userId: user,
      actionId: 'act-rem-left',
      text: 'Hunor errand',
      at: '2026-10-06T13:00:00.000Z',
      nowIso: NOW,
    });
    if (created.status !== 'created') throw new Error('expected created');
    await env.DB.prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .bind(ws, user).run();

    const swept = await processDueReminders(env.DB, '2026-10-06T14:00:00.000Z');
    expect(swept.cancelled).toBe(1);
    expect(await count('chat_messages', `content_text LIKE '⏰ Reminder: Hunor errand%'`)).toBe(0);
  });

  it('queues a Telegram intent row for telegram reminders without live sends', async () => {
    const { ws, user, chat } = await newScope('tg');
    await env.DB.prepare(
      `INSERT INTO telegram_users (telegram_user_id, user_id, selected_workspace_id, active_chat_id, created_at, updated_at)
       VALUES ('777901', ?, ?, ?, ?, ?)`,
    ).bind(user, ws, chat, NOW, NOW).run();
    const created = await createReminder(env.DB, {
      workspaceId: ws,
      userId: user,
      chatId: chat,
      actionId: 'act-rem-tg',
      text: 'Telegram nudge',
      at: '2026-10-06T13:00:00.000Z',
      channel: 'telegram',
      nowIso: NOW,
    });
    if (created.status !== 'created') throw new Error('expected created');

    const swept = await processDueReminders(env.DB, '2026-10-06T14:00:00.000Z');
    expect(swept.delivered).toBe(1);

    const intents = (
      await env.DB.prepare(
        `SELECT payload_json, status FROM outbox WHERE workspace_id = ? AND destination = 'telegram' AND topic = 'send_message' AND payload_json LIKE ?`,
      ).bind(ws, `%${created.reminder.id}%`).all<Record<string, unknown>>()
    ).results ?? [];
    expect(intents).toHaveLength(1);
    const payload = JSON.parse(String(intents[0]!['payload_json'])) as Record<string, unknown>;
    expect(payload['kind']).toBe('reminder');
    expect(payload['reminder_id']).toBe(created.reminder.id);
    expect(payload['telegram_user_id']).toBe('777901');
    // The web record still lands: Telegram is additive, never instead.
    expect(await count('chat_messages', 'id = ?', `msg_rem_${created.reminder.id}`)).toBe(1);
  });

  it('sends queued reminder intents through the existing consumer once', async () => {
    const { ws, user, chat } = await newScope('tgsend');
    await env.DB.prepare(
      `INSERT INTO telegram_users (telegram_user_id, user_id, selected_workspace_id, active_chat_id, created_at, updated_at)
       VALUES ('777902', ?, ?, ?, ?, ?)`,
    ).bind(user, ws, chat, NOW, NOW).run();
    const created = await createReminder(env.DB, {
      workspaceId: ws,
      userId: user,
      chatId: chat,
      actionId: 'act-rem-tgsend',
      text: 'Telegram knock',
      at: '2026-10-06T13:00:00.000Z',
      channel: 'telegram',
      nowIso: NOW,
    });
    if (created.status !== 'created') throw new Error('expected created');
    await processDueReminders(env.DB, '2026-10-06T14:00:00.000Z');

    const sent: Array<Record<string, unknown>> = [];
    const summary = await deliverTelegramOutbox(
      env.DB,
      { TELEGRAM_BOT_TOKEN: 'test-token-999' },
      {
        fetchFn: (async (url: string, init: RequestInit) => {
          sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return new Response(
            JSON.stringify({ ok: true, result: { message_id: 7002, chat: { id: 777902, type: 'private' } } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }),
        clock: () => NOW,
        workspaceId: ws,
      },
    );
    expect(summary.delivered).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.['chat_id']).toBe('777902');
    expect(String(sent[0]?.['text'])).toContain('Telegram knock');
    const row = await env.DB.prepare(
      `SELECT status, payload_json FROM outbox WHERE workspace_id = ? AND topic = 'send_message'`,
    ).bind(ws).first<Record<string, unknown>>();
    expect(row?.['status']).toBe('delivered');
  });

  it('cancels reminder delivery after membership revocation without sending', async () => {
    const { ws, chat } = await newScope('tgrevoke', AVI);
    await addMember(ws, HUNOR);
    await env.DB.prepare(
      `INSERT INTO telegram_users (telegram_user_id, user_id, selected_workspace_id, active_chat_id, created_at, updated_at)
       VALUES ('777903', ?, ?, ?, ?, ?)`,
    ).bind(HUNOR, ws, chat, NOW, NOW).run();
    const created = await createReminder(env.DB, {
      workspaceId: ws,
      userId: HUNOR,
      chatId: chat,
      actionId: 'act-rem-tgrevoke',
      text: 'Revoked nudge',
      at: '2026-10-06T13:00:00.000Z',
      channel: 'telegram',
      nowIso: NOW,
    });
    if (created.status !== 'created') throw new Error('expected created');
    await processDueReminders(env.DB, '2026-10-06T14:00:00.000Z');
    await env.DB.prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .bind(ws, HUNOR).run();

    let calls = 0;
    await deliverTelegramOutbox(
      env.DB,
      { TELEGRAM_BOT_TOKEN: 'test-token-999' },
      {
        fetchFn: (async () => {
          calls += 1;
          return new Response('{}', { status: 500 });
        }),
        clock: () => NOW,
        workspaceId: ws,
      },
    );
    expect(calls).toBe(0);
    const row = await env.DB.prepare(
      `SELECT status FROM outbox WHERE workspace_id = ? AND topic = 'send_message'`,
    ).bind(ws).first<Record<string, unknown>>();
    expect(row?.['status']).toBe('cancelled');
  });

  it('drives reminders through the agent tool boundary', async () => {
    const { ws, user, chat } = await newScope('tool');
    // Fixture instants derive from the real clock because the tool boundary
    // validates futurity against it, not the frozen case clock.
    const fireAt = new Date(Date.now() + 3_600_000).toISOString();
    const afterFire = new Date(Date.now() + 7_200_000).toISOString();
    const viaTool = (actionId: string, toolName: string, toolArgs: unknown, sourceText = 'Remind me about this.') =>
      executeAgentTool({
        db: env.DB,
        workspaceId: ws,
        actorUserId: user,
        actionId,
        chatId: chat,
        sourceText,
        toolName,
        toolArgs,
      });

    const created = await viaTool('act-tool-rem-1', 'create_reminder', {
      text: 'Tool-driven nudge',
      at: fireAt,
    });
    expect(created.status).toBe('applied');
    const reminderId = (created.data as { reminder_id: string }).reminder_id;
    expect(reminderId).toMatch(/^rem_/);

    const invalid = await viaTool('act-tool-rem-2', 'create_reminder', { text: 'Bad time', at: 'tomorrow' });
    expect(invalid.status).toBe('rejected');

    const changed = await viaTool('act-tool-rem-3', 'update_reminder', {
      reminder_id: reminderId,
      text: 'Tool-driven nudge v2',
    });
    expect(changed.status).toBe('applied');

    const cancelled = await viaTool('act-tool-rem-4', 'cancel_reminder', { reminder_id: reminderId });
    expect(cancelled.status).toBe('applied');

    await processDueReminders(env.DB, afterFire);
    expect(await count('chat_messages', `content_text LIKE '⏰ Reminder: Tool-driven%'`)).toBe(0);
  });
});

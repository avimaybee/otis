/**
 * 011B brief delivery integration (real workerd + D1, no live sends).
 *
 * Proves against production service code: chosen-schedule evaluation,
 * workspace/member-scoped candidate reads with honest category omissions,
 * atomic canonical daily brief + saved positions + system message +
 * activity, daily dedupe under concurrent ticks, member isolation, empty
 * days with no outward notification, Telegram intent rows, and read-only
 * /today. Applies the shared 0001-0012 setup plus 0013 locally in this
 * file only; no shared setup is modified.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
// @ts-expect-error vite raw import
import sql0013 from '../../../migrations/0013_briefs.sql?raw';
import {
  buildTodayBrief,
  generateDailyBrief,
  type BriefKernel,
} from '../src/brief/service.js';
import { setMemberSettings } from '@otis/identity';
import { executeAgentTool } from '../src/agent/repository.js';
import { getTurnContext } from '../src/agent/context.js';
import { getWorkspaceEvents } from '@otis/ledger';
import { rebuildProjections } from '@otis/ledger';
import { readBriefCandidates } from '../src/brief/read.js';
import { processScheduledDailyBriefs } from '../src/brief/cron.js';
import { deliverTelegramOutbox } from '../src/inbox/telegramDelivery.js';
import {
  buildBriefDedupeKey,
  evaluateBriefSchedule,
  getLocalDate,
  isValidTimezone,
  nextDueUtc,
  orderSelectionsForSave,
  renderBriefText,
  selectBriefItems,
  type BriefScheduleInput,
  type SelectBriefInput,
} from '../../../packages/brief/src/index.js';

const NOW = '2026-10-06T12:00:00.000Z'; // 15:00 in Europe/Bucharest, a Tuesday.
const STALE_DAYS = 14;

/** The real 011A kernel, injected: the service must never reimplement it. */
const kernel: BriefKernel = {
  evaluateSchedule: (schedule, nowIso, lastGenerated) =>
    evaluateBriefSchedule(schedule as BriefScheduleInput, nowIso, lastGenerated),
  nextDueUtc: (input) => nextDueUtc({ ...input, schedule: input.schedule as BriefScheduleInput }),
  selectItems: (input) => selectBriefItems(input as SelectBriefInput),
  dedupeKey: (workspaceId, userId, localDate) => buildBriefDedupeKey(workspaceId, userId, localDate),
  orderForSave: (items) => orderSelectionsForSave(items),
  renderText: (items) => renderBriefText(items),
  localDate: (nowIso, timezone) => getLocalDate(nowIso, timezone),
  isValidTimezone: (timezone) => isValidTimezone(timezone),
};

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inTrigger = false;
  for (const rawLine of String(sql).split('\n')) {
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

async function seedUser(id: string, firebaseUid: string, email: string, name: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, firebaseUid, email, name, NOW, NOW).run();
}

async function seedWorkspace(id: string, name: string, ownerId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, ?, ?)`,
  ).bind(id, name, ownerId, NOW, NOW).run();
}

async function seedMembership(workspaceId: string, userId: string, role: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(workspaceId, userId, role, NOW, NOW, NOW).run();
}

async function seedSchedule(
  workspaceId: string,
  userId: string,
  overrides: {
    enabled?: number;
    time?: string | null;
    timezone?: string | null;
    weekdays?: string | null;
    channel?: string;
  } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO member_settings (workspace_id, user_id, brief_enabled, brief_local_time, brief_timezone, brief_weekdays, brief_channel, preferred_language, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'en', ?, ?)`,
  ).bind(
    workspaceId,
    userId,
    overrides.enabled ?? 1,
    overrides.time === undefined ? '08:30' : overrides.time,
    overrides.timezone === undefined ? 'Europe/Bucharest' : overrides.timezone,
    overrides.weekdays === undefined ? '[1,2,3,4,5]' : overrides.weekdays,
    overrides.channel ?? 'web',
    NOW,
    NOW,
  ).run();
}

async function seedChat(id: string, workspaceId: string, authorId: string, title: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO chats (id, workspace_id, author_user_id, title, is_archived, activity_cursor, created_at, updated_at, last_activity_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)`,
  ).bind(id, workspaceId, authorId, title, NOW, NOW, NOW).run();
}

async function seedJob(id: string, workspaceId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO system_jobs (id, workspace_id, job_kind, status, scheduled_at, attempt_count, max_attempts, created_at, updated_at)
     VALUES (?, ?, 'summary_refresh', 'succeeded', ?, 1, 3, ?, ?)`,
  ).bind(id, workspaceId, NOW, NOW, NOW).run();
}

async function seedEvent(
  id: string,
  workspaceId: string,
  entityId: string | null,
  kind: string,
  payload: unknown,
  occurredAt: string,
  jobId: string,
  revertsEventId: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO events (id, workspace_id, sequence, entity_id, actor_kind, actor_job_id, kind, schema_version, payload_json, occurred_at, recorded_at, channel, source_job_id, action_id, reverts_event_id, provenance, created_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM events WHERE workspace_id = ?), ?, 'system', ?, ?, 1, ?, ?, ?, 'system', ?, ?, ?, 'stated', ?)`,
  ).bind(id, workspaceId, workspaceId, entityId, jobId, kind, JSON.stringify(payload), occurredAt, NOW, jobId, `act-seed-${id}`, revertsEventId, NOW).run();
}

async function seedEntity(
  id: string,
  workspaceId: string,
  name: string,
  status: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO entities (id, workspace_id, name, kind, status, created_at, updated_at)
     VALUES (?, ?, ?, 'business', ?, ?, ?)`,
  ).bind(id, workspaceId, name, status, NOW, NOW).run();
}

async function seedTask(params: {
  id: string;
  workspaceId: string;
  entityId: string | null;
  title: string;
  assignee: string | null;
  status?: string;
  dueKind: string | null;
  dueLocalDate: string | null;
  dueInstant: string | null;
  sourceEventId: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tasks (id, workspace_id, entity_id, title, assignee_user_id, status, due_kind, due_local_date, due_instant, due_timezone, snooze_until, source_event_id, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)`,
  ).bind(
    params.id,
    params.workspaceId,
    params.entityId,
    params.title,
    params.assignee,
    params.status ?? 'open',
    params.dueKind,
    params.dueLocalDate,
    params.dueInstant,
    params.dueKind ? 'Europe/Bucharest' : null,
    params.sourceEventId,
    NOW,
    NOW,
  ).run();
}

const WS = 'ws-brf';
const AVI = 'usr_brf_avi';
const HUNOR = 'usr_brf_hunor';
const OUTSIDER = 'usr_brf_outsider';

async function count(table: string, where = '', ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`,
  ).bind(...binds).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  for (const stmt of splitSqlStatements(sql0013)) {
    await env.DB.prepare(stmt).run();
  }

  await seedUser(AVI, 'fb_brf_avi', 'avi@brief.test', 'Avi');
  await seedUser(HUNOR, 'fb_brf_hunor', 'hunor@brief.test', 'Hunor');
  await seedUser(OUTSIDER, 'fb_brf_outsider', 'out@brief.test', 'Out');
  await seedUser('usr_brf_solo', 'fb_brf_solo', 'solo@brief.test', 'Solo');
  await seedUser('usr_brf_off', 'fb_brf_off', 'off@brief.test', 'Off');
  await seedUser('usr_brf_late', 'fb_brf_late', 'late@brief.test', 'Late');
  await seedUser('usr_brf_inc', 'fb_brf_inc', 'inc@brief.test', 'Inc');
  await seedUser('usr_brf_race', 'fb_brf_race', 'race@brief.test', 'Race');
  await seedUser('usr_brf_tg', 'fb_brf_tg', 'tg@brief.test', 'Tg');
  await seedUser('usr_brf_nc', 'fb_brf_nc', 'nc@brief.test', 'Nc');
  await seedUser('usr_brf_tg2', 'fb_brf_tg2', 'tg2@brief.test', 'Tg2');
  await seedUser('usr_brf_tg3', 'fb_brf_tg3', 'tg3@brief.test', 'Tg3');
  await seedUser('usr_brf_tg4', 'fb_brf_tg4', 'tg4@brief.test', 'Tg4');
  await seedUser('usr_brf_tg5', 'fb_brf_tg5', 'tg5@brief.test', 'Tg5');

  await seedWorkspace(WS, 'Kerning', AVI);
  await seedWorkspace('ws-brf-empty', 'Empty', 'usr_brf_solo');
  await seedWorkspace('ws-brf-race', 'Race', 'usr_brf_race');
  await seedWorkspace('ws-brf-tg', 'Tgws', 'usr_brf_tg');
  await seedWorkspace('ws-brf-nc', 'Nows', 'usr_brf_nc');
  await seedWorkspace('ws-brf-other', 'Other', OUTSIDER);

  await seedMembership(WS, AVI, 'owner');
  await seedMembership(WS, HUNOR, 'member');
  await seedMembership('ws-brf-empty', 'usr_brf_solo', 'owner');
  await seedMembership('ws-brf-empty', 'usr_brf_off', 'member');
  await seedMembership('ws-brf-empty', 'usr_brf_late', 'member');
  await seedMembership('ws-brf-empty', 'usr_brf_inc', 'member');
  await seedMembership('ws-brf-race', 'usr_brf_race', 'owner');
  await seedMembership('ws-brf-tg', 'usr_brf_tg', 'owner');
  await seedMembership('ws-brf-tg', 'usr_brf_tg5', 'member');
  await seedMembership('ws-brf-nc', 'usr_brf_nc', 'owner');

  await seedSchedule(WS, AVI);
  await seedSchedule('ws-brf-empty', 'usr_brf_solo');
  await seedSchedule('ws-brf-empty', 'usr_brf_off', { enabled: 0 });
  await seedSchedule('ws-brf-empty', 'usr_brf_late', { time: '23:00' });
  await seedSchedule('ws-brf-empty', 'usr_brf_inc', { time: null });
  await seedSchedule('ws-brf-race', 'usr_brf_race');
  await seedSchedule('ws-brf-tg', 'usr_brf_tg', { channel: 'telegram' });
  await seedSchedule('ws-brf-tg', 'usr_brf_tg5', { channel: 'telegram' });
  await seedSchedule('ws-brf-nc', 'usr_brf_nc');

  await seedChat('chat-brf-avi', WS, AVI, 'Avi chat');
  await seedChat('chat-brf-race', 'ws-brf-race', 'usr_brf_race', 'Race chat');
  await seedChat('chat-brf-tg', 'ws-brf-tg', 'usr_brf_tg', 'Tg chat');
  await seedChat('chat-brf-tg5', 'ws-brf-tg', 'usr_brf_tg5', 'Tg5 chat');

  await env.DB.prepare(
    `INSERT INTO telegram_users (telegram_user_id, user_id, selected_workspace_id, active_chat_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind('777001', 'usr_brf_tg', 'ws-brf-tg', 'chat-brf-tg', NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO telegram_users (telegram_user_id, user_id, selected_workspace_id, active_chat_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind('777005', 'usr_brf_tg5', 'ws-brf-tg', 'chat-brf-tg5', NOW, NOW).run();

  // ---- Kerning fixtures: due tasks, teammate/done/null/future exclusions ----
  await seedJob('sysjob-brf-seed', WS);
  await seedEntity('ent-brf-cold', WS, 'Cold Diner', 'cold');
  await seedEntity('ent-brf-warm-old', WS, 'Warm Bistro', 'warm');
  await seedEntity('ent-brf-hot-recent', WS, 'Hot Bakery', 'hot');
  await seedEntity('ent-brf-warm-notes', WS, 'Quiet Bistro', 'warm');
  await seedEntity('ent-brf-warm-undo', WS, 'Returned Bistro', 'warm');
  await seedEvent('evt-brf-contact-old', WS, 'ent-brf-warm-old', 'contact',
    { summary: 'Met owner', channel: 'in_person' }, '2026-09-01T10:00:00.000Z', 'sysjob-brf-seed');
  await seedEvent('evt-brf-contact-undone-old', WS, 'ent-brf-warm-undo', 'contact',
    { summary: 'First visit', channel: 'in_person' }, '2026-09-01T10:00:00.000Z', 'sysjob-brf-seed');
  await seedEvent('evt-brf-contact-undone-new', WS, 'ent-brf-warm-undo', 'contact',
    { summary: 'Quick call', channel: 'phone' }, '2026-10-05T10:00:00.000Z', 'sysjob-brf-seed');
  // The recent contact was undone: last contact must restore to the older one.
  await seedEvent('evt-brf-contact-undo', WS, 'ent-brf-warm-undo', 'revert',
    { target_event_id: 'evt-brf-contact-undone-new' }, NOW, 'sysjob-brf-seed', 'evt-brf-contact-undone-new');
  await seedEvent('evt-brf-contact-recent', WS, 'ent-brf-hot-recent', 'contact',
    { summary: 'Called back', channel: 'phone' }, '2026-10-05T10:00:00.000Z', 'sysjob-brf-seed');
  await seedEvent('evt-brf-note-recent', WS, 'ent-brf-warm-notes', 'note',
    { text: 'Walked past, looked busy' }, '2026-10-05T10:00:00.000Z', 'sysjob-brf-seed');
  await seedEvent('evt-brf-task-due', WS, 'ent-brf-cold', 'task_created',
    { task_id: 't-brf-due', title: 'Send offer to Cold Diner' }, NOW, 'sysjob-brf-seed');
  await seedEvent('evt-brf-task-today', WS, null, 'task_created',
    { task_id: 't-brf-today', title: 'Call supplier' }, NOW, 'sysjob-brf-seed');
  await seedEvent('evt-brf-task-null', WS, null, 'task_created',
    { task_id: 't-brf-null', title: 'Think about signage' }, NOW, 'sysjob-brf-seed');
  await seedTask({
    id: 't-brf-due', workspaceId: WS, entityId: 'ent-brf-cold', title: 'Send offer to Cold Diner',
    assignee: AVI, dueKind: 'date', dueLocalDate: '2026-10-05', dueInstant: null, sourceEventId: 'evt-brf-task-due',
  });
  await seedTask({
    id: 't-brf-today', workspaceId: WS, entityId: null, title: 'Call supplier',
    assignee: null, dueKind: 'date', dueLocalDate: '2026-10-06', dueInstant: null, sourceEventId: 'evt-brf-task-today',
  });
  await seedTask({
    id: 't-brf-null', workspaceId: WS, entityId: null, title: 'Think about signage',
    assignee: AVI, dueKind: null, dueLocalDate: null, dueInstant: null, sourceEventId: 'evt-brf-task-null',
  });
  await seedTask({
    id: 't-brf-future', workspaceId: WS, entityId: null, title: 'Later thing',
    assignee: AVI, dueKind: 'date', dueLocalDate: '2026-10-07', dueInstant: null, sourceEventId: 'evt-brf-task-due',
  });
  await seedTask({
    id: 't-brf-hunor', workspaceId: WS, entityId: null, title: 'Hunor errand',
    assignee: HUNOR, dueKind: 'date', dueLocalDate: '2026-10-05', dueInstant: null, sourceEventId: 'evt-brf-task-due',
  });
  await seedTask({
    id: 't-brf-done', workspaceId: WS, entityId: null, title: 'Finished thing',
    assignee: AVI, status: 'done', dueKind: 'date', dueLocalDate: '2026-10-05', dueInstant: null, sourceEventId: 'evt-brf-task-due',
  });

  // ---- Race workspace: one due task ----
  await seedJob('sysjob-brf-race', 'ws-brf-race');
  await seedEvent('evt-brf-race-task', 'ws-brf-race', null, 'task_created',
    { task_id: 't-brf-race', title: 'Race the clock' }, NOW, 'sysjob-brf-race');
  await seedTask({
    id: 't-brf-race', workspaceId: 'ws-brf-race', entityId: null, title: 'Race the clock',
    assignee: 'usr_brf_race', dueKind: 'date', dueLocalDate: '2026-10-06', dueInstant: null, sourceEventId: 'evt-brf-race-task',
  });

  // ---- Telegram workspace: one due task ----
  await seedJob('sysjob-brf-tg', 'ws-brf-tg');
  await seedEvent('evt-brf-tg-task', 'ws-brf-tg', null, 'task_created',
    { task_id: 't-brf-tg', title: 'Ping the manager' }, NOW, 'sysjob-brf-tg');
  await seedEvent('evt-brf-tg5-task', 'ws-brf-tg', null, 'task_created',
    { task_id: 't-brf-tg5', title: 'Ping the manager five' }, NOW, 'sysjob-brf-tg');
  await seedTask({
    id: 't-brf-tg', workspaceId: 'ws-brf-tg', entityId: null, title: 'Ping the manager',
    assignee: 'usr_brf_tg', dueKind: 'date', dueLocalDate: '2026-10-06', dueInstant: null, sourceEventId: 'evt-brf-tg-task',
  });
  await seedTask({
    id: 't-brf-tg5', workspaceId: 'ws-brf-tg', entityId: null, title: 'Ping the manager five',
    assignee: 'usr_brf_tg5', dueKind: 'date', dueLocalDate: '2026-10-06', dueInstant: null, sourceEventId: 'evt-brf-tg5-task',
  });

  async function seedTelegramWorkspace(tag: string, tgUserId: string): Promise<void> {
    const ws = `ws-brf-tg${tag}`;
    const user = `usr_brf_tg${tag}`;
    const chat = `chat-brf-tg${tag}`;
    await seedWorkspace(ws, `Tgws${tag}`, user);
    await seedMembership(ws, user, 'owner');
    await seedSchedule(ws, user, { channel: 'telegram' });
    await seedChat(chat, ws, user, 'Tg chat');
    await env.DB.prepare(
      `INSERT INTO telegram_users (telegram_user_id, user_id, selected_workspace_id, active_chat_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(tgUserId, user, ws, chat, NOW, NOW).run();
    await seedJob(`sysjob-brf-tg${tag}`, ws);
    await seedEvent(`evt-brf-tg${tag}-task`, ws, null, 'task_created',
      { task_id: `t-brf-tg${tag}`, title: `Ping the manager ${tag}` }, NOW, `sysjob-brf-tg${tag}`);
    await seedTask({
      id: `t-brf-tg${tag}`, workspaceId: ws, entityId: null, title: `Ping the manager ${tag}`,
      assignee: user, dueKind: 'date', dueLocalDate: '2026-10-06', dueInstant: null, sourceEventId: `evt-brf-tg${tag}-task`,
    });
  }
  await seedTelegramWorkspace('2', '777002');
  await seedTelegramWorkspace('3', '777003');
  await seedTelegramWorkspace('4', '777004');

  // ---- No-chat workspace: one due task, no chat row ----
  await seedJob('sysjob-brf-nc', 'ws-brf-nc');
  await seedEvent('evt-brf-nc-task', 'ws-brf-nc', null, 'task_created',
    { task_id: 't-brf-nc', title: 'Knock on doors' }, NOW, 'sysjob-brf-nc');
  await seedTask({
    id: 't-brf-nc', workspaceId: 'ws-brf-nc', entityId: null, title: 'Knock on doors',
    assignee: 'usr_brf_nc', dueKind: 'date', dueLocalDate: '2026-10-06', dueInstant: null, sourceEventId: 'evt-brf-nc-task',
  });

  // ---- Other workspace: must never leak into the Kerning brief ----
  await seedJob('sysjob-brf-other', 'ws-brf-other');
  await seedEvent('evt-brf-other-task', 'ws-brf-other', null, 'task_created',
    { task_id: 't-brf-other', title: 'Foreign secret' }, NOW, 'sysjob-brf-other');
  await seedTask({
    id: 't-brf-other', workspaceId: 'ws-brf-other', entityId: null, title: 'Foreign secret',
    assignee: null, dueKind: 'date', dueLocalDate: '2026-10-01', dueInstant: null, sourceEventId: 'evt-brf-other-task',
  });
});

describe('011B daily brief', () => {
  it('persists a ready canonical brief with positions, message and activity', async () => {
    const result = await generateDailyBrief(env.DB, kernel, {
      workspaceId: WS,
      userId: AVI,
      nowIso: NOW,
      staleAfterDays: STALE_DAYS,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.localDate).toBe('2026-10-06');
    expect(result.itemCount).toBe(5);
    expect(result.delivery).toBe('web');

    const brief = await env.DB.prepare(
      `SELECT id, status, chat_id, message_id, run_id, body_text, item_count FROM briefs WHERE id = ?`,
    ).bind(result.briefId).first<Record<string, unknown>>();
    expect(brief?.['status']).toBe('ready');
    expect(brief?.['item_count']).toBe(5);
    expect(String(brief?.['body_text'])).toContain('Your brief.');
    expect(brief?.['chat_id']).toBe('chat-brf-avi');

    const items = (
      await env.DB.prepare(
        `SELECT position, kind, task_id, entity_id, title, reason, source_event_id, due_label
         FROM brief_items WHERE brief_id = ? ORDER BY position ASC`,
      ).bind(result.briefId).all<Record<string, unknown>>()
    ).results ?? [];
    expect(items.map((row) => [row['position'], row['task_id'] ?? row['entity_id']])).toEqual([
      [1, 't-brf-due'],
      [2, 't-brf-today'],
      [3, 'ent-brf-warm-notes'],
      [4, 'ent-brf-warm-old'],
      [5, 'ent-brf-warm-undo'],
    ]);
    expect(items[0]?.['reason']).toBe('Task due 2026-10-05');
    expect(items[2]?.['reason']).toContain('unknown');
    expect(items[3]?.['reason']).toContain('2026-09-01');
    // Notes never advance last contact: the recent note leaves no contact behind.
    expect(items[2]?.['source_event_id']).toBe('');
    // The undone recent contact is excluded: last contact restores to the older one.
    expect(items[4]?.['reason']).toContain('2026-09-01');
    expect(items[4]?.['source_event_id']).toBe('evt-brf-contact-undone-old');

    const message = await env.DB.prepare(
      `SELECT author_kind, channel, content_text, run_id, sequence FROM chat_messages WHERE id = ?`,
    ).bind(String(brief?.['message_id'])).first<Record<string, unknown>>();
    expect(message?.['author_kind']).toBe('system');
    expect(message?.['channel']).toBe('system');
    expect(String(message?.['content_text'])).toContain('Send offer to Cold Diner');
    expect(message?.['run_id']).toBe(String(brief?.['run_id']));

    const activity = await env.DB.prepare(
      `SELECT type, payload_json FROM run_activity WHERE chat_id = ? AND run_id = ?`,
    ).bind('chat-brf-avi', String(brief?.['run_id'])).first<Record<string, unknown>>();
    expect(activity?.['type']).toBe('answer_saved');
    expect(String(activity?.['payload_json'])).toContain(String(result.briefId));

    const job = await env.DB.prepare(
      `SELECT job_kind, status FROM system_jobs WHERE id = ?`,
    ).bind(`brfjob_${WS}_${AVI}_2026-10-06`).first<Record<string, unknown>>();
    expect(job?.['job_kind']).toBe('scheduled_daily_brief');

    // Web channel: canonical message only, no Telegram intent.
    expect(await count('outbox', 'workspace_id = ?', WS)).toBe(0);
  });

  it('ranks promised and explicitly undated tasks from persisted markers', async () => {
    const ws = 'ws-brf-markers';
    const user = 'usr_brf_mark';
    await seedUser(user, 'fb_brf_mark', 'mark@brief.test', 'Mark');
    await seedWorkspace(ws, 'Markers', user);
    await seedMembership(ws, user, 'owner');
    await seedChat('chat-brf-mark', ws, user, 'Mark chat');
    await env.DB.prepare(
      `INSERT INTO messages_in (id, workspace_id, chat_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
       VALUES ('min-brf-mark', ?, 'chat-brf-mark', ?, 'web', 'ext-brf-mark', 'fp-brf-mark', 'processing', ?, ?)`,
    ).bind(ws, user, NOW, NOW).run();

    const create = (actionId: string, sourceText: string, toolArgs: unknown) =>
      executeAgentTool({
        db: env.DB,
        workspaceId: ws,
        actorUserId: user,
        actionId,
        chatId: 'chat-brf-mark',
        sourceMessageId: 'min-brf-mark',
        sourceText,
        toolName: 'create_task',
        toolArgs,
      });

    const promised = await create('act-mark-promised', 'I promise to send the offer by Monday.', {
      title: 'Send offer',
      due: { kind: 'date', local_date: '2026-10-06', timezone: 'Europe/Bucharest' },
    });
    expect(promised.status).toBe('applied');
    const promisedId = promised.affected_resource_ids?.[0];
    const undated = await create('act-mark-undated', 'Park this for later, no deadline.', {
      title: 'Parked follow-up',
      explicit_no_deadline: true,
    });
    expect(undated.status).toBe('applied');
    const undatedId = undated.affected_resource_ids?.[0];
    const ordinary = await create('act-mark-ordinary', 'Remind me about the contract.', {
      title: 'Review contract',
      due: { kind: 'date', local_date: '2026-10-06', timezone: 'Europe/Bucharest' },
    });
    expect(ordinary.status).toBe('applied');
    const ordinaryId = ordinary.affected_resource_ids?.[0];

    // Markers persist on the projection exactly as created.
    const rows = (
      await env.DB.prepare(
        `SELECT id, explicit_no_deadline, is_promise FROM tasks WHERE workspace_id = ?`,
      ).bind(ws).all<{ id: string; explicit_no_deadline: number; is_promise: number }>()
    ).results ?? [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(promisedId!)?.is_promise).toBe(1);
    expect(byId.get(promisedId!)?.explicit_no_deadline).toBe(0);
    expect(byId.get(undatedId!)?.explicit_no_deadline).toBe(1);
    expect(byId.get(undatedId!)?.is_promise).toBe(0);
    expect(byId.get(ordinaryId!)?.is_promise).toBe(0);
    expect(byId.get(ordinaryId!)?.explicit_no_deadline).toBe(0);

    // Rebuilds from events reproduce the markers: no silent drift.
    const rebuilt = rebuildProjections(await getWorkspaceEvents(env.DB, ws));
    expect(rebuilt.tasks.get(promisedId!)?.is_promise).toBe(true);
    expect(rebuilt.tasks.get(undatedId!)?.explicit_no_deadline).toBe(true);
    expect(rebuilt.tasks.get(ordinaryId!)?.is_promise).toBe(false);

    // Selection ranks the promise first, then the dated task, then the
    // explicitly undated action — from stored truth, not hardcoded flags.
    const candidates = await readBriefCandidates(env.DB, ws, user);
    expect(candidates.tasks.find((task) => task.id === promisedId)?.reason).toBe('promise');
    expect(candidates.tasks.find((task) => task.id === undatedId)?.explicitNoDeadline).toBe(true);
    const selected = kernel.selectItems({
      nowUtcIso: NOW,
      briefLocalDate: '2026-10-06',
      briefTimezone: 'Europe/Bucharest',
      tasks: candidates.tasks,
      leads: [],
      staleAfterDays: STALE_DAYS,
    });
    expect(selected.map((item) => [item.kind, item.taskId])).toEqual([
      ['promise_due', promisedId],
      ['task_due', ordinaryId],
      ['undated', undatedId],
    ]);
    expect(selected[0]?.reason).toBe('Promise due 2026-10-06');
    expect(selected[2]?.reason).toBe('Next action with no deadline');
  });

  it('resolves ordinal references against the newest saved brief in exact saved order', async () => {
    const ws = 'ws-brf-ordinals';
    const user = 'usr_brf_ord';
    await seedUser(user, 'fb_brf_ord', 'ord@brief.test', 'Ord');
    await seedWorkspace(ws, 'Ordinals', user);
    await seedMembership(ws, user, 'owner');
    await seedChat('chat-brf-ord', ws, user, 'Ord chat');
    const now = NOW;

    // Older brief whose second item differs from the newest brief's second.
    // Distinct creation stamps: recency decides, never a timestamp tie.
    await env.DB.prepare(
      `INSERT INTO briefs (id, workspace_id, user_id, local_date, kind, status, body_text, item_count, created_at, updated_at)
       VALUES ('brf-ord-old', ?, ?, '2026-10-04', 'scheduled_daily', 'ready', 'Old.', 2, '2026-10-04T12:00:00.000Z', '2026-10-04T12:00:00.000Z')`,
    ).bind(ws, user).run();
    await env.DB.prepare(
      `INSERT INTO brief_items (brief_id, position, kind, task_id, entity_id, title, reason, source_event_id, due_label)
       VALUES ('brf-ord-old', 1, 'task_due', NULL, NULL, 'Old first', 'Task due', '', NULL),
              ('brf-ord-old', 2, 'task_due', NULL, NULL, 'Old second', 'Task due', '', NULL)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO briefs (id, workspace_id, user_id, local_date, kind, status, body_text, item_count, created_at, updated_at)
       VALUES ('brf-ord-new', ?, ?, '2026-10-06', 'scheduled_daily', 'ready', 'New.', 2, ?, ?)`,
    ).bind(ws, user, now, now).run();
    await env.DB.prepare(
      `INSERT INTO brief_items (brief_id, position, kind, task_id, entity_id, title, reason, source_event_id, due_label)
       VALUES ('brf-ord-new', 1, 'task_due', NULL, NULL, 'New first', 'Task due', '', NULL),
              ('brf-ord-new', 2, 'task_due', NULL, NULL, 'New second', 'Task due', '', NULL)`,
    ).run();

    const context = await getTurnContext(env.DB, {
      workspaceId: ws,
      actorUserId: user,
      chatId: 'chat-brf-ord',
      sourceText: 'Mark the second one done.',
    });
    // Newest brief wins in exact saved order: "the second one" is stable
    // and distinct from the older brief's second item.
    expect(context.systemPrompt).toContain('#2: "New second"');
    expect(context.systemPrompt).not.toContain('Old second');
  });

  it('dedupes concurrent ticks to one canonical brief', async () => {
    const params = {
      workspaceId: 'ws-brf-race',
      userId: 'usr_brf_race',
      nowIso: NOW,
      staleAfterDays: STALE_DAYS,
    };
    const [first, second] = await Promise.all([
      generateDailyBrief(env.DB, kernel, params),
      generateDailyBrief(env.DB, kernel, params),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(['already', 'ready']);
    expect(await count('briefs', 'workspace_id = ?', 'ws-brf-race')).toBe(1);
    expect(await count('chat_messages', 'chat_id = ?', 'chat-brf-race')).toBe(1);
    const ready = first.status === 'ready' ? first : second.status === 'ready' ? second : null;
    expect(ready && ready.status === 'ready' ? ready.itemCount : null).toBe(1);
  });

  it('isolates members and workspaces', async () => {
    const outsider = await generateDailyBrief(env.DB, kernel, {
      workspaceId: WS,
      userId: OUTSIDER,
      nowIso: NOW,
      staleAfterDays: STALE_DAYS,
    });
    expect(outsider).toEqual({ status: 'skipped', reason: 'not_member' });
    const today = await buildTodayBrief(env.DB, kernel, {
      workspaceId: WS,
      userId: OUTSIDER,
      nowIso: NOW,
      staleAfterDays: STALE_DAYS,
    });
    expect(today).toEqual({ status: 'skipped', reason: 'not_member' });
    expect(await count('briefs', 'user_id = ?', OUTSIDER)).toBe(0);
  });

  it('marks empty days handled with no outward notification', async () => {
    const before = await count('briefs');
    const result = await generateDailyBrief(env.DB, kernel, {
      workspaceId: 'ws-brf-empty',
      userId: 'usr_brf_solo',
      nowIso: NOW,
      staleAfterDays: STALE_DAYS,
    });
    expect(result.status).toBe('empty');
    if (result.status !== 'empty') throw new Error('expected empty');
    expect(await count('briefs')).toBe(before + 1);
    expect(await count('chat_messages', 'workspace_id = ?', 'ws-brf-empty')).toBe(0);
    expect(await count('run_activity', 'workspace_id = ?', 'ws-brf-empty')).toBe(0);
    expect(await count('outbox', 'workspace_id = ?', 'ws-brf-empty')).toBe(0);

    const repeat = await generateDailyBrief(env.DB, kernel, {
      workspaceId: 'ws-brf-empty',
      userId: 'usr_brf_solo',
      nowIso: NOW,
      staleAfterDays: STALE_DAYS,
    });
    expect(repeat.status).toBe('already');
    expect(repeat.status === 'already' ? repeat.briefId : null).toBe(result.briefId);
  });

  it('queues a Telegram intent row for telegram-channel members', async () => {
    const result = await generateDailyBrief(env.DB, kernel, {
      workspaceId: 'ws-brf-tg',
      userId: 'usr_brf_tg',
      nowIso: NOW,
      staleAfterDays: STALE_DAYS,
      telegramInstallationId: 'otis_bot',
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.delivery).toBe('telegram_intent');
    expect(result.telegramParts).toBe(1);
    const rows = (
      await env.DB.prepare(
        `SELECT id, destination, topic, status, payload_json FROM outbox WHERE workspace_id = ? AND topic = 'send_message'`,
      ).bind('ws-brf-tg').all<Record<string, unknown>>()
    ).results ?? [];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row['destination']).toBe('telegram');
    expect(row['status']).toBe('pending');
    const payload = JSON.parse(String(row['payload_json'])) as Record<string, unknown>;
    expect(payload['kind']).toBe('brief');
    expect(payload['brief_id']).toBe(result.briefId);
    expect(payload['telegram_user_id']).toBe('777001');
    expect(payload['telegram_chat_id']).toBe('777001');
    expect(String(payload['text'])).toContain('Ping the manager');
    // Canonical web message still exists alongside the intent.
    expect(result.messageId).toBeTruthy();
  });

  it('provisions a canonical chat for first-ever briefs and delivers', async () => {
    const result = await generateDailyBrief(env.DB, kernel, {
      workspaceId: 'ws-brf-nc',
      userId: 'usr_brf_nc',
      nowIso: NOW,
      staleAfterDays: STALE_DAYS,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.delivery).toBe('web');
    expect(result.chatId).toBe('chat_brf_ws-brf-nc_usr_brf_nc');
    expect(result.messageId).toBeTruthy();

    const chat = await env.DB.prepare(
      `SELECT workspace_id, author_user_id, title FROM chats WHERE id = ?`,
    ).bind(result.chatId).first<Record<string, unknown>>();
    expect(chat?.['workspace_id']).toBe('ws-brf-nc');
    expect(chat?.['author_user_id']).toBe('usr_brf_nc');
    expect(chat?.['title']).toBe('Brief');
    expect(await count('chat_messages', 'chat_id = ?', result.chatId)).toBe(1);
    expect(await count('run_activity', 'chat_id = ?', result.chatId)).toBe(1);

    const repeat = await generateDailyBrief(env.DB, kernel, {
      workspaceId: 'ws-brf-nc',
      userId: 'usr_brf_nc',
      nowIso: NOW,
      staleAfterDays: STALE_DAYS,
    });
    expect(repeat.status).toBe('already');
    expect(await count('chats', 'id = ?', result.chatId)).toBe(1);
  });

  it('does nothing for disabled, incomplete, and not-yet-due schedules', async () => {
    const before = await count('briefs', 'workspace_id = ?', 'ws-brf-empty');
    expect(await generateDailyBrief(env.DB, kernel, {
      workspaceId: 'ws-brf-empty', userId: 'usr_brf_off', nowIso: NOW, staleAfterDays: STALE_DAYS,
    })).toEqual({ status: 'skipped', reason: 'schedule_disabled' });
    expect(await generateDailyBrief(env.DB, kernel, {
      workspaceId: 'ws-brf-empty', userId: 'usr_brf_inc', nowIso: NOW, staleAfterDays: STALE_DAYS,
    })).toEqual({ status: 'skipped', reason: 'schedule_incomplete' });
    expect(await generateDailyBrief(env.DB, kernel, {
      workspaceId: 'ws-brf-empty', userId: 'usr_brf_late', nowIso: NOW, staleAfterDays: STALE_DAYS,
    })).toEqual({ status: 'skipped', reason: 'not_yet_due' });
    expect(await count('briefs', 'workspace_id = ?', 'ws-brf-empty')).toBe(before);
  });

  it('answers /today read-only with the same selection', async () => {
    const before = await count('briefs', 'workspace_id = ? AND user_id = ?', WS, AVI);
    const today = await buildTodayBrief(env.DB, kernel, {
      workspaceId: WS,
      userId: AVI,
      nowIso: NOW,
      staleAfterDays: STALE_DAYS,
    });
    expect(today.status).toBe('ok');
    if (today.status !== 'ok') throw new Error('expected ok');
    expect(today.items).toHaveLength(5);
    expect(today.items.map((item) => item.taskId ?? item.entityId)).toEqual([
      't-brf-due',
      't-brf-today',
      'ent-brf-warm-notes',
      'ent-brf-warm-old',
      'ent-brf-warm-undo',
    ]);
    expect(today.text).toContain('Your brief.');
    expect(await count('briefs', 'workspace_id = ? AND user_id = ?', WS, AVI)).toBe(before);
  });

  it('delivers scheduled brief rows through the existing consumer', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const summary = await deliverTelegramOutbox(
      env.DB,
      { TELEGRAM_BOT_TOKEN: 'test-token-999' },
      {
        fetchFn: (async (url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          sent.push(body);
          return new Response(
            JSON.stringify({ ok: true, result: { message_id: 7001, chat: { id: 777001, type: 'private' } } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }),
        clock: () => NOW,
        workspaceId: 'ws-brf-tg',
      },
    );
    expect(summary.delivered).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.['chat_id']).toBe('777001');
    expect(String(sent[0]?.['text'])).toContain('Ping the manager');
    const row = await env.DB.prepare(
      `SELECT status, payload_json FROM outbox WHERE workspace_id = ? AND topic = 'send_message'`,
    ).bind('ws-brf-tg').first<Record<string, unknown>>();
    expect(row?.['status']).toBe('delivered');
    expect(JSON.parse(String(row?.['payload_json']))['telegram_message_id']).toBe(7001);
  });

  it('holds unknown send outcomes without resending', async () => {
    const generated = await generateDailyBrief(env.DB, kernel, {
      workspaceId: 'ws-brf-tg2',
      userId: 'usr_brf_tg2',
      nowIso: NOW,
      staleAfterDays: STALE_DAYS,
    });
    expect(generated.status).toBe('ready');
    let calls = 0;
    const throwing = (_url: string, _init: RequestInit): Promise<Response> => {
      calls += 1;
      throw new Error('synthetic transport failure');
    };
    const options = {
      fetchFn: throwing,
      clock: () => NOW,
      workspaceId: 'ws-brf-tg2',
    };
    await deliverTelegramOutbox(env.DB, { TELEGRAM_BOT_TOKEN: 'test-token-999' }, options);
    const row = await env.DB.prepare(
      `SELECT status FROM outbox WHERE workspace_id = ? AND topic = 'send_message'`,
    ).bind('ws-brf-tg2').first<Record<string, unknown>>();
    expect(row?.['status']).toBe('outcome_unknown');
    await deliverTelegramOutbox(env.DB, { TELEGRAM_BOT_TOKEN: 'test-token-999' }, options);
    expect(calls).toBe(1);
  });

  it('cancels brief delivery after membership revocation', async () => {
    const generated = await generateDailyBrief(env.DB, kernel, {
      workspaceId: 'ws-brf-tg3',
      userId: 'usr_brf_tg3',
      nowIso: NOW,
      staleAfterDays: STALE_DAYS,
    });
    expect(generated.status).toBe('ready');
    await env.DB.prepare(
      `DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`,
    ).bind('ws-brf-tg3', 'usr_brf_tg3').run();
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
        workspaceId: 'ws-brf-tg3',
      },
    );
    expect(calls).toBe(0);
    const row = await env.DB.prepare(
      `SELECT status FROM outbox WHERE workspace_id = ? AND topic = 'send_message'`,
    ).bind('ws-brf-tg3').first<Record<string, unknown>>();
    expect(row?.['status']).toBe('cancelled');
  });

  it('cancels brief rows retargeted to another user/chat without sending', async () => {
    const generated = await generateDailyBrief(env.DB, kernel, {
      workspaceId: 'ws-brf-tg',
      userId: 'usr_brf_tg5',
      nowIso: NOW,
      staleAfterDays: STALE_DAYS,
    });
    expect(generated.status).toBe('ready');
    if (generated.status !== 'ready') throw new Error('expected ready');
    // Retarget the intent row at a teammate's identity in the same workspace:
    // the referenced brief still belongs to usr_brf_tg5 / chat-brf-tg5.
    const pending = await env.DB.prepare(
      `SELECT id, payload_json FROM outbox
       WHERE workspace_id = ? AND topic = 'send_message' AND status = 'pending'
         AND json_extract(payload_json, '$.user_id') = ?`,
    ).bind('ws-brf-tg', 'usr_brf_tg5').first<Record<string, unknown>>();
    expect(pending?.['id']).toBeTruthy();
    const tampered = JSON.parse(String(pending?.['payload_json'])) as Record<string, unknown>;
    tampered['user_id'] = 'usr_brf_tg';
    tampered['chat_id'] = 'chat-brf-tg';
    await env.DB.prepare(
      `UPDATE outbox SET payload_json = ? WHERE id = ?`,
    ).bind(JSON.stringify(tampered), String(pending?.['id'])).run();

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
        workspaceId: 'ws-brf-tg',
      },
    );
    expect(calls).toBe(0);
    const row = await env.DB.prepare(
      `SELECT status, last_error FROM outbox WHERE id = ?`,
    ).bind(String(pending?.['id'])).first<Record<string, unknown>>();
    expect(row?.['status']).toBe('cancelled');
    expect(String(row?.['last_error'])).toContain('identity mismatch');
  });

  it('cancels delivery when member switches brief_channel to web before send', async () => {
    const generated = await generateDailyBrief(env.DB, kernel, {
      workspaceId: 'ws-brf-tg4',
      userId: 'usr_brf_tg4',
      nowIso: NOW,
      staleAfterDays: STALE_DAYS,
    });
    expect(generated.status).toBe('ready');
    await env.DB.prepare(
      `UPDATE member_settings SET brief_channel = 'web' WHERE workspace_id = ? AND user_id = ?`,
    ).bind('ws-brf-tg4', 'usr_brf_tg4').run();
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
        workspaceId: 'ws-brf-tg4',
      },
    );
    expect(calls).toBe(0);
    const row = await env.DB.prepare(
      `SELECT status FROM outbox WHERE workspace_id = ? AND topic = 'send_message'`,
    ).bind('ws-brf-tg4').first<Record<string, unknown>>();
    expect(row?.['status']).toBe('cancelled');
  });
});

describe('B4 due-aware brief sweep (workerd)', () => {
  // NOW is Tuesday 2026-10-06 15:00 Bucharest; the default seeded slot
  // 08:30 (05:30Z) weekdays Mon–Fri has passed with nothing generated.
  const WS_SWEEP = 'ws-brf-sweep';

  // The sweep is global across workspaces: park every other workspace's
  // schedules first so these counts prove selection, not leftover state.
  // This describe runs last in the file, so nothing after it can observe this.
  beforeAll(async () => {
    await seedUser('usr_brf_owner', 'fb_owner', 'owner@sweep.test', 'Owner');
    await seedWorkspace(WS_SWEEP, 'Sweep WS', 'usr_brf_owner');
    await seedMembership(WS_SWEEP, 'usr_brf_owner', 'owner');
    await env.DB.prepare(`UPDATE member_settings SET brief_enabled = 0 WHERE workspace_id <> ?`)
      .bind(WS_SWEEP)
      .run();
  });

  async function readStamp(userId: string, workspaceId: string = WS_SWEEP): Promise<string | null> {
    const row = await env.DB.prepare(
      `SELECT brief_next_due_utc AS stamp FROM member_settings WHERE workspace_id = ? AND user_id = ?`,
    )
      .bind(workspaceId, userId)
      .first<{ stamp: string | null }>();
    return row?.stamp ?? null;
  }

  async function seedSweepMember(
    userId: string,
    schedule: { enabled?: number; time?: string | null },
    stamp: string | null | undefined,
  ): Promise<void> {
    await seedUser(userId, `fb_${userId}`, `${userId}@sweep.test`, userId);
    await seedMembership(WS_SWEEP, userId, 'member');
    await seedSchedule(WS_SWEEP, userId, schedule);
    if (stamp !== undefined) {
      await env.DB.prepare(`UPDATE member_settings SET brief_next_due_utc = ? WHERE workspace_id = ? AND user_id = ?`)
        .bind(stamp, WS_SWEEP, userId)
        .run();
    }
  }

  it('evaluates only due members, advances their stamps, then idles', async () => {
    await seedSweepMember('u_sweep_due', {}, '2026-10-06T05:30:00.000Z');
    await seedSweepMember('u_sweep_future', {}, '2026-10-07T05:30:00.000Z');
    await seedSweepMember('u_sweep_legacy', {}, undefined);
    await seedSweepMember('u_sweep_off', { enabled: 0 }, undefined);

    const first = await processScheduledDailyBriefs(env.DB, NOW);
    expect(first).toEqual({ evaluated: 2, generated: 2, skipped: 0, errors: 0 });
    expect(await readStamp('u_sweep_due')).toBe('2026-10-07T05:30:00.000Z');
    expect(await readStamp('u_sweep_legacy')).toBe('2026-10-07T05:30:00.000Z');
    expect(await readStamp('u_sweep_future')).toBe('2026-10-07T05:30:00.000Z');

    // Every stamp now lies past the sweep instant: the next sweep evaluates
    // nobody instead of re-reading four schedules to relearn not-due.
    const second = await processScheduledDailyBriefs(env.DB, NOW);
    expect(second).toEqual({ evaluated: 0, generated: 0, skipped: 0, errors: 0 });
  });

  it('stamps the coming slot when a member is evaluated before it is due', async () => {
    await seedSweepMember('u_sweep_early', { time: '23:00' }, undefined);
    const result = await processScheduledDailyBriefs(env.DB, NOW);
    expect(result).toEqual({ evaluated: 1, generated: 0, skipped: 1, errors: 0 });
    // 23:00 Bucharest is 20:00Z: still ahead, so the sweep parks there.
    expect(await readStamp('u_sweep_early')).toBe('2026-10-06T20:00:00.000Z');
  });

  it('resets the stamp on schedule edits but preserves it otherwise', async () => {
    await seedSweepMember('u_sweep_edit', {}, '2026-10-07T05:30:00.000Z');
    await setMemberSettings(env.DB, {
      workspaceId: WS_SWEEP,
      userId: 'u_sweep_edit',
      actorUserId: 'u_sweep_edit',
      input: { preferred_language: 'ro' },
    });
    expect(await readStamp('u_sweep_edit')).toBe('2026-10-07T05:30:00.000Z');
    await setMemberSettings(env.DB, {
      workspaceId: WS_SWEEP,
      userId: 'u_sweep_edit',
      actorUserId: 'u_sweep_edit',
      input: { brief_local_time: '09:30' },
    });
    expect(await readStamp('u_sweep_edit')).toBeNull();
  });

  it('F21: due-dated tasks and hot leads survive a UUID-sorted crowd', async () => {
    const WS_CROWD = 'ws-brf-crowd';
    await seedUser('u_crowd', 'fb_crowd', 'crowd@sweep.test', 'Crowd');
    await seedWorkspace(WS_CROWD, 'Crowd WS', 'u_crowd');
    await seedMembership(WS_CROWD, 'u_crowd', 'member');
    await seedJob('job-crowd', WS_CROWD);
    await seedEvent('evt-crowd', WS_CROWD, null, 'note', {}, NOW, 'job-crowd');
    const taskStatements = [];
    for (let i = 0; i < 501; i++) {
      const id = `aaa-undated-${String(i).padStart(3, '0')}`;
      taskStatements.push(
        env.DB.prepare(
          `INSERT INTO tasks (id, workspace_id, entity_id, title, assignee_user_id, status, due_kind, due_local_date, due_instant, due_timezone, snooze_until, source_event_id, revision, created_at, updated_at)
           VALUES (?, ?, NULL, ?, NULL, 'open', NULL, NULL, NULL, NULL, NULL, ?, 1, ?, ?)`,
        ).bind(id, WS_CROWD, `Undated ${i}`, 'evt-crowd', NOW, NOW),
      );
    }
    taskStatements.push(
      env.DB.prepare(
        `INSERT INTO tasks (id, workspace_id, entity_id, title, assignee_user_id, status, due_kind, due_local_date, due_instant, due_timezone, snooze_until, source_event_id, revision, created_at, updated_at)
         VALUES ('zzz-dated-task', ?, NULL, 'Due yesterday', NULL, 'open', 'date', '2026-10-05', NULL, 'Europe/Bucharest', NULL, ?, 1, ?, ?)`,
      ).bind(WS_CROWD, 'evt-crowd', NOW, NOW),
    );
    for (let i = 0; i < taskStatements.length; i += 50) {
      await env.DB.batch(taskStatements.slice(i, i + 50));
    }
    const entityStatements = [];
    for (let i = 0; i < 501; i++) {
      const id = `aaa-warm-${String(i).padStart(3, '0')}`;
      entityStatements.push(
        env.DB.prepare(
          `INSERT INTO entities (id, workspace_id, name, kind, status, created_at, updated_at)
           VALUES (?, ?, ?, 'business', 'warm', ?, ?)`,
        ).bind(id, WS_CROWD, `Warm ${i}`, NOW, NOW),
      );
    }
    entityStatements.push(
      env.DB.prepare(
        `INSERT INTO entities (id, workspace_id, name, kind, status, created_at, updated_at)
         VALUES ('zzz-hot-ent', ?, 'Hot One', 'business', 'hot', ?, ?)`,
      ).bind(WS_CROWD, NOW, NOW),
    );
    for (let i = 0; i < entityStatements.length; i += 50) {
      await env.DB.batch(entityStatements.slice(i, i + 50));
    }

    const candidates = await readBriefCandidates(env.DB, WS_CROWD, 'u_crowd');
    expect(candidates.tasks.some(task => task.id === 'zzz-dated-task')).toBe(true);
    expect(candidates.tasks[0]!.id).toBe('zzz-dated-task');
    expect(candidates.leads.some(lead => lead.entityId === 'zzz-hot-ent')).toBe(true);
    expect(candidates.leads[0]!.entityId).toBe('zzz-hot-ent');
  });
});

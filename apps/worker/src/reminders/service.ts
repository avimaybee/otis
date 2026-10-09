/**
 * @otis/worker/reminders/service
 *
 * Confirmed one-off reminders: create/change/cancel plus the due sweep that
 * delivers them. Scheduler state lives in the reminders table (migration
 * 0018), mirroring the daily-brief delivery shape rather than the ledger:
 * deterministic row/message/activity/run/job ids make every write
 * idempotent, so concurrent sweeps and retried tool calls collapse instead
 * of duplicating.
 *
 * Delivery order per due reminder: claim pending-to-sent conditionally, then
 * persist the canonical system message (web) and/or Telegram intent rows
 * with deterministic ids. A redelivery finds the existing message and only
 * repairs the sent marker, so a crash between persist and mark can neither
 * lose nor duplicate the reminder.
 */

import { readTargetChat, readTelegramLink } from '../brief/read.js';
import { BRIEF_TELEGRAM_INSTALLATION_DEFAULT } from '../brief/service.js';
import { buildTelegramDeliveryStatements } from '../inbox/telegramDelivery.js';
import { ENTITY_FAMILY_SQL, familyBinds } from '../entities/canonical.js';

export interface ReminderRow {
  id: string;
  workspace_id: string;
  user_id: string;
  chat_id: string | null;
  action_id: string;
  text: string;
  remind_at: string;
  timezone: string | null;
  channel: 'web' | 'telegram';
  status: 'pending' | 'sent' | 'cancelled' | 'failed';
  last_error: string | null;
  rule_id: string | null;
  rule_revision: number | null;
  interaction_id: string | null;
  head_event_id: string | null;
  updated_at: string;
}

export interface CreateReminderParams {
  workspaceId: string;
  userId: string;
  chatId?: string | null;
  actionId: string;
  text: string;
  at: string;
  timezone?: string | null;
  channel?: 'web' | 'telegram';
  nowIso: string;
}

export type CreateReminderResult =
  | { status: 'created'; reminder: ReminderRow }
  | { status: 'already'; reminder: ReminderRow }
  | { status: 'rejected'; code: 'not_member' | 'invalid_time'; message: string };

export interface UpdateReminderParams {
  workspaceId: string;
  userId: string;
  reminderId: string;
  text?: string;
  at?: string;
  timezone?: string | null;
  channel?: 'web' | 'telegram';
  nowIso: string;
}

export type UpdateReminderResult =
  | { status: 'updated'; reminder: ReminderRow }
  | { status: 'rejected'; code: 'not_found' | 'settled' | 'invalid_time'; message: string };

export type CancelReminderResult =
  | { status: 'cancelled'; reminder: ReminderRow }
  | { status: 'already'; reminder: ReminderRow }
  | { status: 'rejected'; code: 'not_found'; message: string };

export interface DueRemindersResult {
  delivered: number;
  cancelled: number;
  failed: number;
}

function toRow(r: Record<string, unknown>): ReminderRow {
  return {
    id: String(r['id']),
    workspace_id: String(r['workspace_id']),
    user_id: String(r['user_id']),
    chat_id: r['chat_id'] ? String(r['chat_id']) : null,
    action_id: String(r['action_id']),
    text: String(r['text']),
    remind_at: String(r['remind_at']),
    timezone: r['timezone'] ? String(r['timezone']) : null,
    channel: r['channel'] === 'telegram' ? 'telegram' : 'web',
    status: r['status'] as ReminderRow['status'],
    last_error: r['last_error'] ? String(r['last_error']) : null,
    rule_id: r.rule_id ? String(r.rule_id) : null,
    rule_revision: r.rule_revision == null ? null : Number(r.rule_revision),
    interaction_id: r.interaction_id ? String(r.interaction_id) : null,
    head_event_id: r.head_event_id ? String(r.head_event_id) : null,
    updated_at: String(r.updated_at),
  };
}

async function isMember(db: D1Database, workspaceId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS ok FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
    .bind(workspaceId, userId)
    .first();
  return row !== null;
}

export async function createReminder(
  db: D1Database,
  params: CreateReminderParams,
): Promise<CreateReminderResult> {
  if (!(await isMember(db, params.workspaceId, params.userId))) {
    return { status: 'rejected', code: 'not_member', message: 'Not a workspace member.' };
  }
  if (Number.isNaN(Date.parse(params.at)) || Date.parse(params.at) <= Date.parse(params.nowIso)) {
    return {
      status: 'rejected',
      code: 'invalid_time',
      message: 'Reminder time must lie in the future.',
    };
  }
  const id = `rem_${crypto.randomUUID()}`;
  const channel = params.channel ?? 'web';
  const inserted = await db
    .prepare(
      `INSERT INTO reminders (id, workspace_id, user_id, chat_id, action_id, text, remind_at, timezone, channel, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(workspace_id, action_id) DO NOTHING RETURNING *`,
    )
    .bind(
      id,
      params.workspaceId,
      params.userId,
      params.chatId ?? null,
      params.actionId,
      params.text,
      params.at,
      params.timezone ?? null,
      channel,
      params.nowIso,
      params.nowIso,
    )
    .first<Record<string, unknown>>();
  if (inserted) return { status: 'created', reminder: toRow(inserted) };
  const existing = await db
    .prepare(`SELECT * FROM reminders WHERE workspace_id = ? AND action_id = ?`)
    .bind(params.workspaceId, params.actionId)
    .first<Record<string, unknown>>();
  // A retried tool call with the same action identity replays the recorded
  // row instead of creating a duplicate reminder.
  return { status: 'already', reminder: toRow(existing!) };
}

async function loadOwnedReminder(
  db: D1Database,
  workspaceId: string,
  userId: string,
  reminderId: string,
): Promise<ReminderRow | null> {
  // No existence oracle across members: another member's id reads as
  // not found, never as forbidden.
  const row = await db
    .prepare(`SELECT * FROM reminders WHERE workspace_id = ? AND id = ? AND user_id = ?`)
    .bind(workspaceId, reminderId, userId)
    .first<Record<string, unknown>>();
  return row ? toRow(row) : null;
}

export async function updateReminder(
  db: D1Database,
  params: UpdateReminderParams,
): Promise<UpdateReminderResult> {
  const current = await loadOwnedReminder(db, params.workspaceId, params.userId, params.reminderId);
  if (!current) {
    return { status: 'rejected', code: 'not_found', message: `Reminder '${params.reminderId}' not found.` };
  }
  if (current.status !== 'pending') {
    return {
      status: 'rejected',
      code: 'settled',
      message: `Reminder is already ${current.status} and cannot be changed.`,
    };
  }
  if (params.at !== undefined && (Number.isNaN(Date.parse(params.at)) || Date.parse(params.at) <= Date.parse(params.nowIso))) {
    return { status: 'rejected', code: 'invalid_time', message: 'Reminder time must lie in the future.' };
  }
  const next = {
    text: params.text ?? current.text,
    at: params.at ?? current.remind_at,
    timezone: params.timezone !== undefined ? params.timezone : current.timezone,
    channel: params.channel ?? current.channel,
  };
  const updated = await db
    .prepare(
      `UPDATE reminders SET text = ?, remind_at = ?, timezone = ?, channel = ?, updated_at = ?
       WHERE id = ? AND status = 'pending' RETURNING *`,
    )
    .bind(next.text, next.at, next.timezone, next.channel, params.nowIso, params.reminderId)
    .first<Record<string, unknown>>();
  if (!updated) {
    const raced = await loadOwnedReminder(db, params.workspaceId, params.userId, params.reminderId);
    return {
      status: 'rejected',
      code: 'settled',
      message: `Reminder is already ${raced?.status ?? 'settled'} and cannot be changed.`,
    };
  }
  return { status: 'updated', reminder: toRow(updated) };
}

export async function cancelReminder(
  db: D1Database,
  params: { workspaceId: string; userId: string; reminderId: string; nowIso: string },
): Promise<CancelReminderResult> {
  const current = await loadOwnedReminder(db, params.workspaceId, params.userId, params.reminderId);
  if (!current) {
    return { status: 'rejected', code: 'not_found', message: `Reminder '${params.reminderId}' not found.` };
  }
  if (current.status === 'cancelled') {
    return { status: 'already', reminder: current };
  }
  if (current.status !== 'pending') {
    return {
      status: 'rejected',
      code: 'not_found',
      message: `Reminder '${params.reminderId}' already ${current.status} and cannot be cancelled.`,
    };
  }
  const updated = await db
    .prepare(`UPDATE reminders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending' RETURNING *`)
    .bind(params.nowIso, params.reminderId)
    .first<Record<string, unknown>>();
  if (!updated) {
    // Lost a concurrent transition: report the durable truth, not a guess.
    const raced = await loadOwnedReminder(db, params.workspaceId, params.userId, params.reminderId);
    if (!raced) {
      return { status: 'rejected', code: 'not_found', message: `Reminder '${params.reminderId}' not found.` };
    }
    if (raced.status === 'cancelled') return { status: 'already', reminder: raced };
    return {
      status: 'rejected',
      code: 'not_found',
      message: `Reminder '${params.reminderId}' already ${raced.status} and cannot be cancelled.`,
    };
  }
  return { status: 'cancelled', reminder: toRow(updated) };
}

function reminderCopy(reminder: ReminderRow): string {
  return `⏰ Reminder: ${reminder.text}`;
}

async function resolveDeliveryChat(
  db: D1Database,
  reminder: ReminderRow,
  nowIso: string,
): Promise<string> {
  if (reminder.chat_id) {
    const stored = await db
      .prepare(`SELECT id FROM chats WHERE id = ? AND workspace_id = ? AND author_user_id = ? AND is_archived = 0`)
      .bind(reminder.chat_id, reminder.workspace_id, reminder.user_id)
      .first();
    if (stored) return reminder.chat_id;
  }
  const recent = await readTargetChat(db, reminder.workspace_id, reminder.user_id);
  if (recent) return recent.id;
  // First-ever delivery surface: provision the member's own canonical chat,
  // mirroring the daily-brief provisioning (deterministic id, one chat).
  const chatId = `chat_rem_${reminder.workspace_id}_${reminder.user_id}`;
  await db
    .prepare(
      `INSERT INTO chats (id, workspace_id, author_user_id, title, model_override, is_archived, activity_cursor, created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, 'Reminders', NULL, 0, 0, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(chatId, reminder.workspace_id, reminder.user_id, nowIso, nowIso, nowIso)
    .run();
  return chatId;
}

async function deliverReminder(
  db: D1Database,
  reminder: ReminderRow,
  nowIso: string,
  telegramInstallationId: string,
): Promise<'delivered' | 'failed' | 'cancelled'> {
  const chatId = await resolveDeliveryChat(db, reminder, nowIso);
  const messageId = `msg_rem_${reminder.id}`;
  const activityId = `act_rem_${reminder.id}`;
  const runId = `run_rem_${reminder.id}`;
  const jobId = `job_rem_${reminder.id}`;
  const text = reminderCopy(reminder);

  // Redelivery collapses: the deterministic message id proves a previous
  // sweep already persisted the payload, so only the sent marker is
  // repaired instead of duplicating the message. A crash between persist
  // and mark therefore heals forward on the next sweep — never lost (the
  // message exists) and never duplicated (the id is immutable).
  const existing = await db
    .prepare(`SELECT id FROM chat_messages WHERE id = ?`)
    .bind(messageId)
    .first();
  if (!existing) {
    const guardId = `reminder_delivery_${crypto.randomUUID()}`;
    const rule = reminder.rule_id ? await db.prepare('SELECT entity_id FROM reminder_rules WHERE workspace_id = ? AND id = ?').bind(reminder.workspace_id, reminder.rule_id).first<{ entity_id: string | null }>() : null;
    const statements: D1PreparedStatement[] = [
      db.prepare(`${ENTITY_FAMILY_SQL} INSERT INTO ledger_guards(id, guard_ok) VALUES (?, (SELECT 1 FROM reminders pending
        WHERE pending.id = ? AND pending.workspace_id = ? AND pending.user_id = ? AND pending.status = 'pending'
        AND pending.text = ? AND pending.remind_at = ?
        AND EXISTS (SELECT 1 FROM workspace_users m WHERE m.workspace_id = pending.workspace_id AND m.user_id = pending.user_id)
        AND (pending.rule_id IS NULL OR EXISTS (SELECT 1 FROM reminder_rules r WHERE r.id = pending.rule_id AND r.workspace_id = pending.workspace_id AND r.user_id = pending.user_id AND r.status = 'active' AND r.revision = pending.rule_revision
          AND (pending.interaction_id IS NULL OR EXISTS (SELECT 1 FROM interaction_state quote WHERE quote.workspace_id = pending.workspace_id AND quote.root_event_id = pending.interaction_id AND quote.head_event_id = pending.head_event_id AND quote.state = 'active' AND json_extract(quote.head_value_json, '$.role') = json_extract(r.spec_json, '$.role')
            AND (json_extract(r.spec_json, '$.if_no_contact') != 1 OR (
              NOT EXISTS (SELECT 1 FROM interaction_state contact JOIN events ce ON ce.id = contact.head_event_id AND ce.workspace_id = contact.workspace_id WHERE contact.workspace_id = pending.workspace_id AND contact.entity_id IN (SELECT id FROM family) AND contact.state = 'active' AND contact.occurred_at >= quote.occurred_at AND (contact.kind = 'contact' OR contact.kind = 'visit' AND json_extract(ce.payload_json, '$.contact_made') = 1))
              AND NOT EXISTS (SELECT 1 FROM events sent WHERE sent.workspace_id = pending.workspace_id AND sent.entity_id IN (SELECT id FROM family) AND sent.kind = 'message_sent_by_member' AND sent.occurred_at >= quote.occurred_at AND NOT EXISTS (SELECT 1 FROM events reverted WHERE reverted.workspace_id = sent.workspace_id AND reverted.kind = 'revert' AND (reverted.reverts_event_id = sent.id OR json_extract(reverted.payload_json, '$.target_event_id') = sent.id)))
            )))))
        )))`).bind(...familyBinds(reminder.workspace_id, rule?.entity_id ?? '__none__'), guardId, reminder.id, reminder.workspace_id, reminder.user_id, reminder.text, reminder.remind_at),
      db.prepare(
        `INSERT OR IGNORE INTO system_jobs (id, workspace_id, job_kind, status, scheduled_at, attempt_count, max_attempts, created_at, updated_at)
         VALUES (?, ?, 'reminder', 'succeeded', ?, 1, 3, ?, ?)`,
      ).bind(jobId, reminder.workspace_id, nowIso, nowIso, nowIso),
      db.prepare(
        `INSERT OR IGNORE INTO agent_runs (id, workspace_id, chat_id, source_job_id, executor_kind, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'system', 'succeeded', ?, ?)`,
      ).bind(runId, reminder.workspace_id, chatId, jobId, nowIso, nowIso),
      db.prepare(
        `INSERT OR IGNORE INTO chat_messages (id, workspace_id, chat_id, author_kind, channel, content_text, run_id, sequence, created_at, updated_at)
         SELECT ?, ?, ?, 'system', 'system', ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ? FROM chat_messages WHERE chat_id = ?`,
      ).bind(messageId, reminder.workspace_id, chatId, text, runId, nowIso, nowIso, chatId),
      db.prepare(
        `UPDATE chats SET activity_cursor = activity_cursor + 1, last_activity_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(nowIso, nowIso, chatId),
      db.prepare(
        `INSERT OR IGNORE INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
         SELECT ?, ?, ?, ?, activity_cursor, 'answer_saved', ?, ? FROM chats WHERE id = ?`,
      ).bind(
        activityId,
        reminder.workspace_id,
        chatId,
        runId,
        JSON.stringify({ reply: text, reminder_id: reminder.id, scheduled: true }),
        nowIso,
        chatId,
      ),
    ];
    if (reminder.channel === 'telegram') {
      // No link degrades to the web message only, mirroring the daily
      // brief: receipt is guaranteed, channel preference is best-effort.
      const link = await readTelegramLink(db, reminder.user_id, reminder.workspace_id);
      if (link) {
        statements.push(
          ...buildTelegramDeliveryStatements(db, {
            workspaceId: reminder.workspace_id,
            userId: reminder.user_id,
            chatId,
            sourceMessageId: `reminder:${reminder.id}`,
            runId,
            kind: 'reminder',
            key: reminder.id,
            text,
            reminderId: reminder.id,
            target: {
              botInstallationId: telegramInstallationId,
              telegramUserId: link.telegramUserId,
              telegramChatId: link.telegramUserId,
            },
          }),
        );
      }
    }
    statements.push(db.prepare("UPDATE reminders SET status = 'sent', updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'pending'").bind(nowIso, reminder.id, reminder.workspace_id));
    if (reminder.rule_id) statements.push(db.prepare('UPDATE reminder_rule_cursors SET last_delivered_at = ? WHERE workspace_id = ? AND rule_id = ? AND rule_revision = ?').bind(nowIso, reminder.workspace_id, reminder.rule_id, reminder.rule_revision));
    statements.push(db.prepare('DELETE FROM ledger_guards WHERE id = ?').bind(guardId));
    try {
      await db.batch(statements);
    } catch (err) {
      // A concurrent sweep won the deterministic ids: the payload exists,
      // so fall through to the sent marker instead of failing. Anything
      // else is a genuine delivery failure for the caller to record.
      const raced = await db
        .prepare(`SELECT id FROM chat_messages WHERE id = ?`)
        .bind(messageId)
        .first();
      if (!raced) {
        if (String(err).includes('guard_ok')) {
          await db.prepare("UPDATE reminders SET status = 'cancelled', last_error = 'Follow-up changed or its condition was satisfied.', updated_at = ? WHERE id = ? AND status = 'pending' AND text = ? AND remind_at = ?").bind(nowIso, reminder.id, reminder.text, reminder.remind_at).run();
          return 'cancelled';
        }
        throw err;
      }
    }
  }
  const marked = await db
    .prepare(`UPDATE reminders SET status = 'sent', updated_at = ? WHERE id = ? AND status = 'pending'`)
    .bind(nowIso, reminder.id)
    .run();
  if ((marked.meta.changes ?? 0) === 1) return 'delivered';
  // Lost the mark race after persisting: another sweep owns the marker.
  return (await isSent(db, reminder.id)) ? 'delivered' : 'failed';
}

async function isSent(db: D1Database, reminderId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT status FROM reminders WHERE id = ?`)
    .bind(reminderId)
    .first<{ status: string }>();
  return row?.status === 'sent';
}

/**
 * Due sweep: delivers pending reminders whose instant passed, earliest
 * first, bounded per sweep. Removed members auto-cancel instead of
 * delivering; failures record honestly and never retry silently.
 */
export async function processDueReminders(
  db: D1Database,
  nowIso: string,
  opts?: { limit?: number; telegramInstallationId?: string },
): Promise<DueRemindersResult> {
  const result: DueRemindersResult = { delivered: 0, cancelled: 0, failed: 0 };
  if (Number.isNaN(Date.parse(nowIso))) throw new Error(`Invalid now instant: ${nowIso}.`);
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
  const installationId = opts?.telegramInstallationId ?? BRIEF_TELEGRAM_INSTALLATION_DEFAULT;

  const rows = (
    await db
      .prepare(
        `SELECT * FROM reminders WHERE status = 'pending' AND remind_at <= ? ORDER BY remind_at ASC LIMIT ?`,
      )
      .bind(nowIso, limit)
      .all<Record<string, unknown>>()
  ).results ?? [];

  for (const row of rows) {
    const reminder = toRow(row);
    try {
      if (!(await isMember(db, reminder.workspace_id, reminder.user_id))) {
        await db
          .prepare(`UPDATE reminders SET status = 'cancelled', last_error = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
          .bind('Workspace membership revoked before delivery.', nowIso, reminder.id)
          .run();
        result.cancelled++;
        continue;
      }
      // Liveness gate (not a claim): skips rows a concurrent sweep already
      // took past pending. Mutual exclusion lives in the deterministic
      // payload ids (a concurrent persist collides on PK and collapses into
      // the sent marker) and the conditional sent mark below — exactly one
      // message ever persists per reminder.
      const outcome = await deliverReminder(db, reminder, nowIso, installationId);
      if (outcome === 'delivered') {
        result.delivered++;
      } else if (outcome === 'cancelled') {
        result.cancelled++;
      } else {
        await db
          .prepare(`UPDATE reminders SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
          .bind('Delivery did not settle.', nowIso, reminder.id)
          .run();
        result.failed++;
      }
    } catch (err) {
      await db
        .prepare(`UPDATE reminders SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
        .bind(err instanceof Error ? err.message.slice(0, 500) : 'Delivery failed.', nowIso, reminder.id)
        .run();
      result.failed++;
    }
  }
  return result;
}

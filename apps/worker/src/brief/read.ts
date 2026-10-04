/**
 * @otis/worker/brief/read
 *
 * Workspace-scoped candidate reads for 011B. Every query filters by
 * workspace_id; task reads additionally scope to the requesting member
 * (assignee is the member or unassigned team work) per the documented
 * brief policy. Tasks assigned to a teammate never enter your brief.
 *
 * Honest omissions (reported schema gaps, not silent policy):
 * - Promise markers: the task projection carries no reason/promise marker
 *   and keyword matching is forbidden, so every due task maps with reason
 *   'task'. The promise rank group is inactive until a persisted marker
 *   exists (e.g. reason_key on tasks or a task_created payload flag).
 * - Explicit undated actions: a null due cannot be proven explicit (the
 *   transient explicit_no_deadline arg is never persisted), so null-due
 *   tasks pass explicitNoDeadline=false and the kernel excludes them as
 *   pending clarification. The undated group is inactive until the flag is
 *   persisted on the task_created payload/projection.
 * - Deal values: quotes live on separate events with offered/expected roles
 *   and no task attribution policy, so valueMinor/currency pass null; the
 *   kernel orders by age then stable ID until a value policy is decided.
 */

import type { LocalBriefLead, LocalBriefSchedule, LocalBriefTask } from './types.js';

const READ_LIMIT = 500;

export async function readMembership(
  db: D1Database,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS ok FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
    .bind(workspaceId, userId)
    .first<{ ok: number }>();
  return row !== null;
}

export async function readMemberBriefSchedule(
  db: D1Database,
  workspaceId: string,
  userId: string,
): Promise<LocalBriefSchedule | null> {
  const row = await db
    .prepare(
      `SELECT brief_enabled, brief_local_time, brief_timezone, brief_weekdays, brief_channel
       FROM member_settings WHERE workspace_id = ? AND user_id = ?`,
    )
    .bind(workspaceId, userId)
    .first<{
      brief_enabled: number;
      brief_local_time: string | null;
      brief_timezone: string | null;
      brief_weekdays: string | null;
      brief_channel: string;
    }>();
  if (!row) return null;
  let weekdays: number[] | null = null;
  if (row.brief_weekdays) {
    try {
      const parsed: unknown = JSON.parse(String(row.brief_weekdays));
      weekdays = Array.isArray(parsed) ? (parsed as number[]) : null;
    } catch {
      weekdays = null;
    }
  }
  return {
    enabled: Number(row.brief_enabled) === 1,
    localTime: row.brief_local_time,
    timezone: row.brief_timezone,
    weekdays,
    channel: row.brief_channel === 'telegram' ? 'telegram' : 'web',
  };
}

export async function readLastGeneratedLocalDate(
  db: D1Database,
  workspaceId: string,
  userId: string,
  kind: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT local_date FROM briefs
       WHERE workspace_id = ? AND user_id = ? AND kind = ?
       ORDER BY local_date DESC LIMIT 1`,
    )
    .bind(workspaceId, userId, kind)
    .first<{ local_date: string }>();
  return row ? String(row.local_date) : null;
}

export async function findBrief(
  db: D1Database,
  workspaceId: string,
  userId: string,
  localDate: string,
): Promise<{ id: string; status: string } | null> {
  const row = await db
    .prepare(
      `SELECT id, status FROM briefs
       WHERE workspace_id = ? AND user_id = ? AND local_date = ? AND kind = 'scheduled_daily'`,
    )
    .bind(workspaceId, userId, localDate)
    .first<{ id: string; status: string }>();
  return row ? { id: String(row.id), status: String(row.status) } : null;
}

export async function readTargetChat(
  db: D1Database,
  workspaceId: string,
  userId: string,
): Promise<{ id: string } | null> {
  const row = await db
    .prepare(
      `SELECT id FROM chats
       WHERE workspace_id = ? AND author_user_id = ? AND is_archived = 0
       ORDER BY last_activity_at DESC, id DESC LIMIT 1`,
    )
    .bind(workspaceId, userId)
    .first<{ id: string }>();
  return row ? { id: String(row.id) } : null;
}

export async function readTelegramLink(
  db: D1Database,
  userId: string,
  workspaceId: string,
): Promise<{ telegramUserId: string } | null> {
  const row = await db
    .prepare(
      `SELECT telegram_user_id FROM telegram_users
       WHERE user_id = ? AND selected_workspace_id = ? LIMIT 1`,
    )
    .bind(userId, workspaceId)
    .first<{ telegram_user_id: string }>();
  return row ? { telegramUserId: String(row.telegram_user_id) } : null;
}

async function readDisputedEntities(db: D1Database, workspaceId: string): Promise<Set<string>> {
  const rows = (
    await db
      .prepare(
        `SELECT DISTINCT entity_id FROM entity_state
         WHERE workspace_id = ? AND state = 'disputed' LIMIT ${READ_LIMIT}`,
      )
      .bind(workspaceId)
      .all<{ entity_id: string }>()
  ).results ?? [];
  return new Set(rows.map((row) => String(row.entity_id)));
}

interface TaskRow {
  id: string;
  entity_id: string | null;
  title: string;
  status: string;
  due_kind: string | null;
  due_local_date: string | null;
  due_instant: string | null;
  due_timezone: string | null;
  snooze_until: string | null;
  source_event_id: string;
}

interface EntityRow {
  id: string;
  name: string;
  status: string;
}

export interface BriefCandidates {
  tasks: LocalBriefTask[];
  leads: LocalBriefLead[];
}

/**
 * Typed last contact per entity: the latest occurred_at over confirmed
 * contact events, member-confirmed sent drafts, and visits with
 * contact_made=true. Notes, plain visits and unsent drafts never qualify.
 * Events undone by a later revert are excluded under current ledger
 * semantics (a revert names its target via reverts_event_id; v1 has no
 * redo), so an undone contact restores the prior active one. One windowed
 * query per entity chunk (D1 bind headroom) returns exactly the latest row
 * per entity — no global LIMIT that could drop an entity's contact.
 * Returns the contact instant plus its event id (source reference).
 */
async function readLastContacts(
  db: D1Database,
  workspaceId: string,
  entityIds: string[],
): Promise<Map<string, { at: string; eventId: string }>> {
  const contacts = new Map<string, { at: string; eventId: string }>();
  const CHUNK = 90;
  for (let offset = 0; offset < entityIds.length; offset += CHUNK) {
    const chunk = entityIds.slice(offset, offset + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = (
      await db
        .prepare(
          `SELECT entity_id, id, occurred_at FROM (
             SELECT entity_id, id, occurred_at,
               ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY occurred_at DESC, id DESC) AS rn
             FROM events
             WHERE workspace_id = ? AND entity_id IN (${placeholders})
               AND (kind IN ('contact', 'message_sent_by_member')
                 OR (kind = 'visit' AND json_extract(payload_json, '$.contact_made') = 1))
               AND NOT EXISTS (
                 SELECT 1 FROM events AS reverted_by
                 WHERE reverted_by.workspace_id = events.workspace_id
                   AND reverted_by.reverts_event_id = events.id
               )
           ) WHERE rn = 1`,
        )
        .bind(workspaceId, ...chunk)
        .all<{ entity_id: string; id: string; occurred_at: string }>()
    ).results ?? [];
    for (const row of rows) {
      if (typeof row.occurred_at !== 'string' || Number.isNaN(Date.parse(row.occurred_at))) continue;
      contacts.set(String(row.entity_id), { at: String(row.occurred_at), eventId: String(row.id) });
    }
  }
  return contacts;
}

export async function readBriefCandidates(
  db: D1Database,
  workspaceId: string,
  userId: string,
): Promise<BriefCandidates> {
  const disputed = await readDisputedEntities(db, workspaceId);

  const taskRows = (
    await db
      .prepare(
        `SELECT id, entity_id, title, status, due_kind, due_local_date, due_instant,
                due_timezone, snooze_until, source_event_id
         FROM tasks
         WHERE workspace_id = ? AND status = 'open'
           AND (assignee_user_id = ? OR assignee_user_id IS NULL)
         ORDER BY id ASC LIMIT ${READ_LIMIT}`,
      )
      .bind(workspaceId, userId)
      .all<TaskRow>()
  ).results ?? [];

  const tasks: LocalBriefTask[] = taskRows.map((row) => ({
    id: String(row.id),
    entityId: row.entity_id === null ? null : String(row.entity_id),
    title: String(row.title),
    status: 'open' as const,
    dueKind:
      row.due_kind === 'date' ? ('date' as const) : row.due_kind === 'instant' ? ('instant' as const) : null,
    dueLocalDate: row.due_local_date === null ? null : String(row.due_local_date),
    dueInstantAt: row.due_instant === null ? null : String(row.due_instant),
    dueTimezone: row.due_timezone === null ? null : String(row.due_timezone),
    snoozeUntil: row.snooze_until === null ? null : String(row.snooze_until),
    // No persisted promise marker exists; never derive one from wording.
    reason: 'task' as const,
    // Explicit no-deadline is not persisted; null dues stay unprovable.
    explicitNoDeadline: false,
    // No quote-to-task value policy exists; values stay out of ranking.
    valueMinor: null,
    currency: null,
    sourceEventId: String(row.source_event_id),
    disputed: row.entity_id !== null && disputed.has(String(row.entity_id)),
  }));

  const entityRows = (
    await db
      .prepare(
        `SELECT id, name, status FROM entities
         WHERE workspace_id = ? AND status IN ('warm', 'hot')
         ORDER BY id ASC LIMIT ${READ_LIMIT}`,
      )
      .bind(workspaceId)
      .all<EntityRow>()
  ).results ?? [];
  const contacts = await readLastContacts(
    db,
    workspaceId,
    entityRows.map((row) => String(row.id)),
  );

  const leads: LocalBriefLead[] = entityRows.map((row) => {
    const entityId = String(row.id);
    const contact = contacts.get(entityId) ?? null;
    return {
      entityId,
      name: String(row.name),
      status: String(row.status),
      lastContactAt: contact ? contact.at : null,
      // No lead value policy exists (offered vs expected roles undecided).
      valueMinor: null,
      currency: null,
      sourceEventId: contact ? contact.eventId : '',
      disputed: disputed.has(entityId),
    };
  });

  return { tasks, leads };
}

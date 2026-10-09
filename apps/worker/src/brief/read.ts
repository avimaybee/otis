/**
 * @otis/worker/brief/read
 *
 * Workspace-scoped candidate reads for 011B. Every query filters by
 * workspace_id; task reads additionally scope to the requesting member
 * (assignee is the member or unassigned team work) per the documented
 * brief policy. Tasks assigned to a teammate never enter your brief.
 *
 * Honest omissions (reported schema gaps, not silent policy):
 * - Deal values: quotes live on separate events with offered/expected roles
 *   and no task attribution policy, so valueMinor/currency pass null; the
 *   kernel orders by age then stable ID until a value policy is decided.
 */

import type { LocalBriefLead, LocalBriefSchedule, LocalBriefTask } from './types.js';
import { canonicalEntityMap } from '../entities/canonical.js';
import { readEffectiveLastContacts } from '../entities/contacts.js';

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
         WHERE workspace_id = ? AND state = 'disputed'
           AND NOT EXISTS (SELECT 1 FROM entity_redirects r WHERE r.workspace_id = entity_state.workspace_id AND r.source_entity_id = entity_state.entity_id)
         LIMIT ${READ_LIMIT}`,
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
  explicit_no_deadline: number | null;
  is_promise: number | null;
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
const readLastContacts = readEffectiveLastContacts;

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
                due_timezone, snooze_until, explicit_no_deadline, is_promise, source_event_id
         FROM tasks
         WHERE workspace_id = ? AND status = 'open'
           AND (assignee_user_id = ? OR assignee_user_id IS NULL)
         -- Due-dated first so a UUID-sorted prefix can never crowd dated
         -- work out of the bounded candidate set; the kernel still applies
         -- snooze, dispute and final ranking. Undated rows keep id order.
         ORDER BY
           CASE WHEN due_instant IS NOT NULL OR due_local_date IS NOT NULL THEN 0 ELSE 1 END ASC,
           COALESCE(due_instant, due_local_date, '9999-12-31') ASC,
           id ASC LIMIT ${READ_LIMIT}`,
      )
      .bind(workspaceId, userId)
      .all<TaskRow>()
  ).results ?? [];

  const taskClients = await canonicalEntityMap(db, workspaceId, taskRows.map(row => row.entity_id).filter((id): id is string => Boolean(id)));
  const tasks: LocalBriefTask[] = taskRows.map((row) => ({
    id: String(row.id),
    entityId: row.entity_id === null ? null : taskClients.get(row.entity_id)?.id ?? row.entity_id,
    title: String(row.title),
    status: 'open' as const,
    dueKind:
      row.due_kind === 'date' ? ('date' as const) : row.due_kind === 'instant' ? ('instant' as const) : null,
    dueLocalDate: row.due_local_date === null ? null : String(row.due_local_date),
    dueInstantAt: row.due_instant === null ? null : String(row.due_instant),
    dueTimezone: row.due_timezone === null ? null : String(row.due_timezone),
    snoozeUntil: row.snooze_until === null ? null : String(row.snooze_until),
    // Persisted markers feed the kernel directly: an explicit member
    // promise ranks first, an explicit no-deadline choice joins the undated
    // group. Pre-marker rows read false and keep historical behavior.
    reason: Number(row.is_promise ?? 0) === 1 ? ('promise' as const) : ('task' as const),
    explicitNoDeadline: Number(row.explicit_no_deadline ?? 0) === 1,
    // No quote-to-task value policy exists; values stay out of ranking.
    valueMinor: null,
    currency: null,
    sourceEventId: String(row.source_event_id),
    disputed: row.entity_id !== null && disputed.has(taskClients.get(row.entity_id)?.id ?? row.entity_id),
  }));

  const entityRows = (
    await db
      .prepare(
        `SELECT id, name, status FROM entities
         WHERE workspace_id = ? AND status IN ('warm', 'hot')
           AND NOT EXISTS (SELECT 1 FROM entity_redirects r WHERE r.workspace_id = entities.workspace_id AND r.source_entity_id = entities.id)
         -- Hot before warm ('hot' < 'warm' in binary collation) for the same
         -- anti-crowding reason as tasks above; staleness ranking stays in
         -- the kernel, which sees contact dates this query cannot order by.
         ORDER BY status ASC, id ASC LIMIT ${READ_LIMIT}`,
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

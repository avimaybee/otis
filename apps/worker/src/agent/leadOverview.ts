/**
 * @otis/worker/agent/leadOverview
 * One purpose-built read for lead overviews, shared by the agent tool and
 * read-only pagination. Set-based scoped SQL: leads, next open tasks,
 * effective contacts and readable owners assemble together — never one
 * query per lead. Counts always cover the entire filtered set so a page of
 * rows is never mistaken for the whole dataset.
 */

export type LeadOverviewColumn = 'status' | 'next_step' | 'due' | 'owner' | 'last_contact';

export const LEAD_OVERVIEW_COLUMNS: readonly LeadOverviewColumn[] = [
  'status',
  'next_step',
  'due',
  'owner',
  'last_contact',
];

/** Hard page bound: limits transfer/render cost, never dataset access. */
export const LEAD_OVERVIEW_MAX_LIMIT = 50;
export const LEAD_OVERVIEW_DEFAULT_LIMIT = 25;

export interface LeadOverviewFilters {
  status?: string;
  overdue_only?: boolean;
  without_next_step?: boolean;
}

export interface LeadOverviewRow {
  lead_id: string;
  name: string;
  status: string;
  disputed: boolean;
  owner: { user_id: string; display_name: string } | null;
  next_task: {
    id: string;
    title: string;
    due_kind: 'date' | 'instant' | null;
    due_local_date: string | null;
    due_instant: string | null;
    due_timezone: string | null;
    snooze_until: string | null;
    overdue: boolean;
  } | null;
  last_contact_at: string | null;
}

export interface LeadOverviewPage {
  applied_filters: LeadOverviewFilters;
  as_of: string;
  counts: {
    total: number;
    by_status: Record<string, number>;
    overdue_open: number;
    without_next_step: number;
  };
  columns: LeadOverviewColumn[];
  rows: LeadOverviewRow[];
  page: {
    limit: number;
    next_cursor: string | null;
    has_more: boolean;
  };
}

interface RankedLeadRow {
  id: string;
  name: string;
  status: string;
  assigned_user_id: string | null;
  task_id: string | null;
  task_title: string | null;
  due_kind: 'date' | 'instant' | null;
  due_local_date: string | null;
  due_instant: string | null;
  due_timezone: string | null;
  snooze_until: string | null;
  rank_group: number;
  due_sort: string;
}

function localDateInTimezone(nowIso: string, timezone: string | null): string {
  if (!timezone) return nowIso.slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(nowIso));
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : nowIso.slice(0, 10);
  } catch {
    return nowIso.slice(0, 10);
  }
}

function encodeCursor(rankGroup: number, dueSort: string, name: string, id: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([rankGroup, dueSort, name, id]));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(cursor: string): [number, string, string, string] | null {
  try {
    const padded = cursor.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 4 &&
      typeof parsed[0] === 'number' &&
      typeof parsed[1] === 'string' &&
      typeof parsed[2] === 'string' &&
      typeof parsed[3] === 'string'
    ) {
      return parsed as [number, string, string, string];
    }
    return null;
  } catch {
    return null;
  }
}

const LEAD_SELECT = `
  SELECT e.id AS id, e.name AS name, e.status AS status, e.assigned_user_id AS assigned_user_id,
    t.id AS task_id, t.title AS task_title, t.due_kind AS due_kind,
    t.due_local_date AS due_local_date, t.due_instant AS due_instant,
    t.due_timezone AS due_timezone, t.snooze_until AS snooze_until,
    CASE
      WHEN t.id IS NULL THEN 2
      WHEN t.snooze_until IS NOT NULL AND t.snooze_until > :nowSnooze THEN 1
      WHEN t.due_instant IS NOT NULL AND t.due_instant <= :nowDue THEN 0
      WHEN t.due_local_date IS NOT NULL AND t.due_local_date <= :localDate THEN 0
      WHEN t.due_instant IS NOT NULL OR t.due_local_date IS NOT NULL THEN 1
      ELSE 2
    END AS rank_group,
    COALESCE(t.due_instant, t.due_local_date, '9999-12-31') AS due_sort
  FROM entities e
  LEFT JOIN (
    SELECT entity_id, id, title, due_kind, due_local_date, due_instant, due_timezone, snooze_until
    FROM (
      SELECT entity_id, id, title, due_kind, due_local_date, due_instant, due_timezone, snooze_until,
        ROW_NUMBER() OVER (
          PARTITION BY entity_id
          ORDER BY
            CASE WHEN due_instant IS NOT NULL OR due_local_date IS NOT NULL THEN 0 ELSE 1 END ASC,
            COALESCE(due_instant, due_local_date, '9999-12-31') ASC,
            id ASC
        ) AS rn
      FROM tasks
      WHERE workspace_id = :tasksWs AND status = 'open' AND entity_id IS NOT NULL
    )
    WHERE rn = 1
  ) t ON t.entity_id = e.id
  WHERE e.workspace_id = :entitiesWs AND e.kind = 'lead'
`;

export async function readLeadOverview(
  db: D1Database,
  args: {
    workspaceId: string;
    actorUserId?: string;
    nowIso?: string;
    filters?: LeadOverviewFilters;
    columns?: LeadOverviewColumn[];
    limit?: number;
    cursor?: string;
  },
): Promise<LeadOverviewPage> {
  const nowIso = args.nowIso ?? new Date().toISOString();
  const filters: LeadOverviewFilters = {
    ...(args.filters?.status ? { status: args.filters.status } : {}),
    ...(args.filters?.overdue_only ? { overdue_only: true } : {}),
    ...(args.filters?.without_next_step ? { without_next_step: true } : {}),
  };
  const columns = (args.columns ?? [...LEAD_OVERVIEW_COLUMNS]).filter((c): c is LeadOverviewColumn =>
    (LEAD_OVERVIEW_COLUMNS as readonly string[]).includes(c),
  );
  const limit = Math.min(
    Math.max(1, Math.floor(args.limit ?? LEAD_OVERVIEW_DEFAULT_LIMIT)),
    LEAD_OVERVIEW_MAX_LIMIT,
  );

  // Member-local calendar for date-only deadlines; UTC day when unknown.
  let memberTimezone: string | null = null;
  if (args.actorUserId) {
    const tzRow = await db
      .prepare(`SELECT brief_timezone, interpretation_timezone FROM member_settings WHERE workspace_id = ? AND user_id = ?`)
      .bind(args.workspaceId, args.actorUserId)
      .first<{ brief_timezone: string | null; interpretation_timezone: string | null }>();
    memberTimezone = tzRow?.interpretation_timezone || tzRow?.brief_timezone || null;
  }
  const localDate = localDateInTimezone(nowIso, memberTimezone);

  // The ranked subquery exposes bare column names (id, name, status,
  // rank_group, due_sort); the outer query filters and pages on those.
  const statusClause = filters.status ? ` AND status = ?` : '';
  const flagClause =
    `${filters.overdue_only ? ` AND rank_group = 0` : ''}` +
    `${filters.without_next_step ? ` AND task_id IS NULL` : ''}`;

  const rankedSql = `SELECT * FROM (${LEAD_SELECT.replaceAll(':tasksWs', '?')
    .replaceAll(':entitiesWs', '?')
    .replaceAll(':nowSnooze', '?')
    .replaceAll(':nowDue', '?')
    .replaceAll(':localDate', '?')}) AS ranked WHERE 1 = 1${statusClause}${flagClause}`;
  // Placeholder order follows the template: snooze now, due-instant now,
  // local date, tasks scope, entities scope, then status filter.
  const baseBinds: unknown[] = [nowIso, nowIso, localDate, args.workspaceId, args.workspaceId];
  if (filters.status) baseBinds.push(filters.status);

  // Full-set counts over the filtered set: aggregates only, no row transfer.
  const countRows = (
    await db
      .prepare(
        `SELECT status AS status, COUNT(*) AS total,
            SUM(CASE WHEN rank_group = 0 THEN 1 ELSE 0 END) AS overdue_open,
            SUM(CASE WHEN task_id IS NULL THEN 1 ELSE 0 END) AS without_next_step
         FROM (${rankedSql}) GROUP BY status`,
      )
      .bind(...baseBinds)
      .all<{ status: string; total: number; overdue_open: number; without_next_step: number }>()
  ).results ?? [];
  const byStatus: Record<string, number> = {};
  let total = 0;
  let overdueOpen = 0;
  let withoutNextStep = 0;
  for (const row of countRows) {
    const count = Number(row.total);
    byStatus[String(row.status)] = count;
    total += count;
    overdueOpen += Number(row.overdue_open);
    withoutNextStep += Number(row.without_next_step);
  }

  // Keyset page: deterministic order (rank, due, name, id); the cursor is an
  // opaque as-of bookmark, not an immutable snapshot across fresh reads.
  let cursorSql = '';
  const cursorBinds: unknown[] = [];
  if (args.cursor) {
    const decoded = decodeCursor(args.cursor);
    if (!decoded) throw new Error('Invalid overview cursor.');
    const [group, dueSort, name, id] = decoded;
    cursorSql = ` AND (rank_group > ? OR (rank_group = ? AND (due_sort > ? OR (due_sort = ? AND (name > ? OR (name = ? AND id > ?))))))`;
    cursorBinds.push(group, group, dueSort, dueSort, name, name, id);
  }
  const pageRows = (
    await db
      .prepare(
        `SELECT * FROM (${rankedSql}) AS page WHERE 1 = 1${cursorSql} ORDER BY rank_group ASC, due_sort ASC, name ASC, id ASC LIMIT ${limit + 1}`,
      )
      .bind(...baseBinds, ...cursorBinds)
      .all<Record<string, unknown>>()
  ).results ?? [];
  const toRanked = (r: Record<string, unknown>): RankedLeadRow => ({
    id: String(r['id']),
    name: String(r['name']),
    status: String(r['status']),
    assigned_user_id: r['assigned_user_id'] ? String(r['assigned_user_id']) : null,
    task_id: r['task_id'] ? String(r['task_id']) : null,
    task_title: r['task_title'] ? String(r['task_title']) : null,
    due_kind: r['due_kind'] === 'date' || r['due_kind'] === 'instant' ? r['due_kind'] : null,
    due_local_date: r['due_local_date'] ? String(r['due_local_date']) : null,
    due_instant: r['due_instant'] ? String(r['due_instant']) : null,
    due_timezone: r['due_timezone'] ? String(r['due_timezone']) : null,
    snooze_until: r['snooze_until'] ? String(r['snooze_until']) : null,
    rank_group: Number(r['rank_group']),
    due_sort: String(r['due_sort']),
  });
  const fetched = pageRows.map(toRanked);
  const hasMore = fetched.length > limit;
  const visible = hasMore ? fetched.slice(0, limit) : fetched;
  const last = visible[visible.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.rank_group, last.due_sort, last.name, last.id) : null;

  const entityIds = visible.map((row) => row.id);
  const contacts = await readEffectiveContacts(db, args.workspaceId, entityIds);
  const owners = await readOwnerNames(
    db,
    visible.map((row) => row.assigned_user_id).filter((id): id is string => id !== null),
  );
  const disputed = await readDisputedSet(db, args.workspaceId, entityIds);

  const rows: LeadOverviewRow[] = visible.map((row) => ({
    lead_id: row.id,
    name: row.name,
    status: row.status,
    disputed: disputed.has(row.id),
    owner: row.assigned_user_id
      ? { user_id: row.assigned_user_id, display_name: owners.get(row.assigned_user_id) ?? 'Unknown member' }
      : null,
    next_task: row.task_id
      ? {
          id: row.task_id,
          title: row.task_title ?? '',
          due_kind: row.due_kind,
          due_local_date: row.due_local_date,
          due_instant: row.due_instant,
          due_timezone: row.due_timezone,
          snooze_until: row.snooze_until,
          overdue: row.rank_group === 0,
        }
      : null,
    last_contact_at: contacts.get(row.id) ?? null,
  }));

  return {
    applied_filters: filters,
    as_of: nowIso,
    counts: {
      total,
      by_status: byStatus,
      overdue_open: overdueOpen,
      without_next_step: withoutNextStep,
    },
    columns,
    rows,
    page: { limit, next_cursor: nextCursor, has_more: hasMore },
  };
}

async function readEffectiveContacts(
  db: D1Database,
  workspaceId: string,
  entityIds: string[],
): Promise<Map<string, string>> {
  const contacts = new Map<string, string>();
  for (let i = 0; i < entityIds.length; i += 50) {
    const chunk = entityIds.slice(i, i + 50);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = (
      await db
        .prepare(
          `SELECT entity_id, occurred_at FROM (
            SELECT entity_id, occurred_at,
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
        .all<{ entity_id: string; occurred_at: string }>()
    ).results ?? [];
    for (const row of rows) {
      if (typeof row.occurred_at !== 'string' || Number.isNaN(Date.parse(row.occurred_at))) continue;
      contacts.set(String(row.entity_id), String(row.occurred_at));
    }
  }
  return contacts;
}

async function readOwnerNames(db: D1Database, userIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(userIds)];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = (
      await db
        .prepare(`SELECT id, display_name FROM users WHERE id IN (${placeholders})`)
        .bind(...chunk)
        .all<{ id: string; display_name: string }>()
    ).results ?? [];
    for (const row of rows) names.set(String(row.id), String(row.display_name));
  }
  return names;
}

async function readDisputedSet(db: D1Database, workspaceId: string, entityIds: string[]): Promise<Set<string>> {
  const disputed = new Set<string>();
  for (let i = 0; i < entityIds.length; i += 50) {
    const chunk = entityIds.slice(i, i + 50);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = (
      await db
        .prepare(
          `SELECT entity_id FROM entity_state
           WHERE workspace_id = ? AND entity_id IN (${placeholders}) AND state = 'disputed'`,
        )
        .bind(workspaceId, ...chunk)
        .all<{ entity_id: string }>()
    ).results ?? [];
    for (const row of rows) disputed.add(String(row.entity_id));
  }
  return disputed;
}

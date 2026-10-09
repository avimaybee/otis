import { WORKSPACE_CANONICAL_SQL, canonicalEntityId } from './canonical.js';

export function localDay(now: string, zone = 'UTC'): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
    const get = (type: string) => parts.find(p => p.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch { return now.slice(0, 10); }
}

export type WorkFilters = { entity_id?: string; task_status?: string; assignee_user_id?: string; overdue_only?: boolean; due_before?: string; due_after?: string };
/** Shared overdue-first work list. Counts include every filtered row; transfers are bounded. */
export async function readWork(db: D1Database, workspace: string, user: string, options: { filters?: WorkFilters; limit?: number; cursor?: string; now?: string } = {}) {
  const filters = options.filters ?? {}, limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Choose a work page size from 1 to 50.');
  const metadata = await db.prepare(`SELECT w.business_revision, s.interpretation_timezone FROM workspaces w
    JOIN workspace_users m ON m.workspace_id = w.id AND m.user_id = ?
    LEFT JOIN member_settings s ON s.workspace_id = w.id AND s.user_id = m.user_id WHERE w.id = ?`).bind(user, workspace).first<{ business_revision: number; interpretation_timezone: string | null }>();
  if (!metadata) throw new Error('Work is unavailable in this workspace.');
  let now = options.now ?? new Date().toISOString(), after: [number, string, string] | null = null;
  const scope = JSON.stringify([workspace, user, filters]);
  if (options.cursor) {
    try { const c = JSON.parse(decodeURIComponent(escape(atob(options.cursor))));
      if (c.scope !== scope || c.revision !== metadata.business_revision || !Array.isArray(c.after) || c.after.length !== 3 || !Number.isInteger(c.after[0]) || typeof c.after[1] !== 'string' || typeof c.after[2] !== 'string' || !Number.isFinite(Date.parse(c.now))) throw new Error();
      now = c.now; after = c.after;
    } catch { throw new Error('This work list changed or its page link is invalid. Refresh it.'); }
  }
  const entity = filters.entity_id ? await canonicalEntityId(db, workspace, filters.entity_id) ?? '__missing__' : null;
  const zones = (await db.prepare('SELECT DISTINCT due_timezone AS zone FROM tasks WHERE workspace_id = ? AND due_kind = \'date\' AND due_timezone IS NOT NULL').bind(workspace).all<{ zone: string }>()).results ?? [];
  const fallback = metadata.interpretation_timezone ?? 'UTC';
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const days = [...new Set([fallback, ...zones.map(z => z.zone)])].map(zone => `(${quote(zone)}, ${quote(localDay(now, zone))})`).join(',');
  const binds: unknown[] = [workspace, workspace, workspace, now, now, localDay(now, fallback), workspace, user];
  const conditions = ['t.workspace_id = ?', 'EXISTS (SELECT 1 FROM workspace_users WHERE workspace_id = t.workspace_id AND user_id = ?)'];
  if (entity) { conditions.push('em.entity_id = ?'); binds.push(entity); }
  if (filters.task_status) { conditions.push('t.status = ?'); binds.push(filters.task_status); }
  if (filters.assignee_user_id) { conditions.push('t.assignee_user_id = ?'); binds.push(filters.assignee_user_id); }
  if (filters.due_before) { conditions.push('(t.due_local_date <= ? OR t.due_instant <= ?)'); binds.push(filters.due_before, filters.due_before); }
  if (filters.due_after) { conditions.push('(t.due_local_date >= ? OR t.due_instant >= ?)'); binds.push(filters.due_after, filters.due_after); }
  const base = `${WORKSPACE_CANONICAL_SQL}, local_days(zone, day) AS (VALUES ${days}), work AS (
    SELECT t.*, t.entity_id AS origin_entity_id, em.entity_id AS canonical_entity_id, ent.name AS entity_name,
      assignee.display_name AS assignee_name, e.actor_user_id, u.display_name AS actor_name, e.recorded_at, e.channel, e.source_message_id,
      CASE WHEN t.status != 'open' THEN 3
        WHEN (t.snooze_until IS NULL OR t.snooze_until <= ?) AND
          (t.due_instant <= ? OR t.due_local_date <= COALESCE(ld.day, ?)) THEN 0
        WHEN t.due_instant IS NOT NULL OR t.due_local_date IS NOT NULL THEN 1 ELSE 2 END AS rank_group,
      COALESCE(t.due_instant, t.due_local_date, '9999-12-31') AS due_sort
    FROM tasks t LEFT JOIN entity_map em ON em.origin_id = t.entity_id
      LEFT JOIN entities ent ON ent.workspace_id = t.workspace_id AND ent.id = em.entity_id
      LEFT JOIN local_days ld ON ld.zone = t.due_timezone
      LEFT JOIN users assignee ON assignee.id = t.assignee_user_id
      LEFT JOIN events e ON e.workspace_id = t.workspace_id AND e.id = t.source_event_id
      LEFT JOIN users u ON u.id = e.actor_user_id
    WHERE ${conditions.join(' AND ')}), filtered AS (SELECT * FROM work ${filters.overdue_only ? 'WHERE rank_group = 0' : ''}) `;
  const results = await db.batch([
    db.prepare(`${base} SELECT COUNT(*) AS total, SUM(rank_group = 0) AS overdue, SUM(status = 'open') AS open, SUM(status = 'open' AND rank_group = 2) AS undated FROM filtered`).bind(...binds),
    db.prepare(`${base} SELECT * FROM filtered ${after ? 'WHERE (rank_group, due_sort, id) > (?, ?, ?)' : ''} ORDER BY rank_group, due_sort, id LIMIT ?`).bind(...binds, ...after ?? [], limit + 1),
  ]);
  const found = (results[1]!.results ?? []) as Record<string, unknown>[], last = found[Math.min(limit, found.length) - 1], more = found.length > limit;
  const totals = results[0]!.results![0] as { total: number; overdue: number | null; open: number | null; undated: number | null };
  return { as_of: now, as_of_business_revision: metadata.business_revision, counts: { total: Number(totals.total), overdue: Number(totals.overdue), open: Number(totals.open), undated: Number(totals.undated) },
    rows: found.slice(0, limit).map(r => ({ ...r, overdue: r.rank_group === 0, source: { event_id: r.source_event_id, message_id: r.source_message_id, actor_user_id: r.actor_user_id, actor_name: r.actor_name, recorded_at: r.recorded_at, channel: r.channel } })),
    has_more: more, next_cursor: more ? btoa(unescape(encodeURIComponent(JSON.stringify({ scope, revision: metadata.business_revision, now, after: [last!.rank_group, last!.due_sort, last!.id] })))) : null };
}

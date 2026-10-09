import type { FollowUpPage, FollowUpRow } from '@otis/contracts';

/** Only the acting member's explicitly configured rules; metadata is not a timer. */
export async function readFollowUps(
  db: D1Database,
  workspace: string,
  user: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<FollowUpPage> {
  const limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error('Choose a page size from 1 to 50.');
  let after = '',
    revision: number | null = null;
  if (options.cursor) {
    try {
      const c = JSON.parse(atob(options.cursor));
      if (
        c.workspace !== workspace ||
        c.user !== user ||
        typeof c.after !== 'string' ||
        !Number.isSafeInteger(c.revision)
      )
        throw new Error();
      after = c.after;
      revision = c.revision;
    } catch {
      throw new Error('This follow-up page is invalid. Refresh it.');
    }
  }
  const where =
    "r.workspace_id = ? AND r.user_id = ? AND r.status != 'cancelled' AND EXISTS (SELECT 1 FROM workspace_users m WHERE m.workspace_id = r.workspace_id AND m.user_id = r.user_id)";
  const [metadata, counts, result] = await db.batch([
    db
      .prepare(
        'SELECT w.business_revision FROM workspaces w JOIN workspace_users m ON m.workspace_id = w.id AND m.user_id = ? WHERE w.id = ?',
      )
      .bind(user, workspace),
    db
      .prepare(`SELECT COUNT(*) AS total FROM reminder_rules r WHERE ${where}`)
      .bind(workspace, user),
    db
      .prepare(
        `SELECT r.id, r.entity_id, r.text, r.timezone, r.channel, r.spec_json, r.status, r.revision, c.next_due, c.last_delivered_at,
      e.actor_user_id, u.display_name AS actor_name, e.source_message_id, e.recorded_at, e.channel AS source_channel
      FROM reminder_rules r LEFT JOIN reminder_rule_cursors c ON c.rule_id = r.id AND c.workspace_id = r.workspace_id
      LEFT JOIN events e ON e.id = r.source_event_id AND e.workspace_id = r.workspace_id LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE ${where} AND r.id > ? ORDER BY r.id LIMIT ?`,
      )
      .bind(workspace, user, after, limit + 1),
  ]);
  const current = Number(
    (metadata!.results[0] as { business_revision?: number } | undefined)?.business_revision,
  );
  if (!Number.isSafeInteger(current))
    throw new Error('Follow-ups are unavailable in this workspace.');
  if (revision !== null && revision !== current)
    throw new Error('Follow-ups changed. Refresh before loading another page.');
  const rows = (result!.results as Record<string, unknown>[])
    .slice(0, limit)
    .map(
      ({ spec_json, ...row }) =>
        ({ ...row, spec: JSON.parse(String(spec_json)) }) as unknown as FollowUpRow,
    );
  const more = result!.results.length > limit;
  return {
    rows,
    total: Number((counts!.results[0] as { total: number }).total),
    as_of_business_revision: current,
    has_more: more,
    next_cursor: more
      ? btoa(JSON.stringify({ workspace, user, revision: current, after: rows.at(-1)!.id }))
      : null,
  };
}

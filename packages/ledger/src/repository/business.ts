import type { AttachmentLink, EntityContact, EntityRedirect, ReminderRule } from '@otis/contracts';
import type { LedgerProjectionState } from '../types.js';

const tables = [
  'entity_contacts',
  'entity_redirects',
  'attachment_links',
  'reminder_rules',
] as const;
/** Optional details are hydrated only for their writers, delete or complete replay/Undo. */
export async function hydrateBusinessDetails(
  db: D1Database,
  workspaceId: string,
  state: LedgerProjectionState,
  entityIds?: string[],
  include: readonly (typeof tables)[number][] = tables,
): Promise<void> {
  const filtered = entityIds?.length
    ? ` AND entity_id IN (${entityIds.map(() => '?').join(',')})`
    : '';
  const redirectQuery = entityIds?.length
    ? db
        .prepare(
          `WITH RECURSIVE chain(id, depth) AS (
    SELECT id, 0 FROM entities WHERE workspace_id = ? AND id IN (${entityIds.map(() => '?').join(',')})
    UNION ALL SELECT r.target_entity_id, chain.depth + 1 FROM entity_redirects r JOIN chain ON r.source_entity_id = chain.id WHERE r.workspace_id = ? AND chain.depth < 32)
    SELECT r.* FROM entity_redirects r WHERE r.workspace_id = ? AND
      (r.source_entity_id IN (SELECT id FROM chain) OR r.target_entity_id IN (${entityIds.map(() => '?').join(',')}))`,
        )
        .bind(workspaceId, ...entityIds, workspaceId, workspaceId, ...entityIds)
    : db.prepare('SELECT * FROM entity_redirects WHERE workspace_id = ?').bind(workspaceId);
  const results = await db.batch(
    include.map((table) =>
      table === 'entity_redirects'
        ? redirectQuery
        : db
            .prepare(`SELECT * FROM ${table} WHERE workspace_id = ?${filtered}`)
            .bind(workspaceId, ...(entityIds ?? [])),
    ),
  );
  const rows = (table: (typeof tables)[number]) =>
    (results[include.indexOf(table)]?.results ?? []) as Record<string, unknown>[];
  if (include.includes('entity_contacts'))
    state.contacts = new Map(
      rows('entity_contacts').map((r) => {
        const row = {
          ...r,
          comparison_key: String(r.comparison_key),
          is_primary: Boolean(r.is_primary),
        } as unknown as EntityContact;
        return [row.id, row];
      }),
    );
  if (include.includes('entity_redirects'))
    state.redirects = new Map(
      rows('entity_redirects').map((r) => {
        const { decisions_json, ...rest } = r;
        const row = {
          ...rest,
          decisions: JSON.parse(String(decisions_json)),
        } as unknown as EntityRedirect;
        return [row.source_entity_id, row];
      }),
    );
  if (include.includes('attachment_links'))
    state.attachmentLinks = new Map(
      rows('attachment_links').map((r) => {
        const row = r as unknown as AttachmentLink;
        return [row.id, row];
      }),
    );
  if (include.includes('reminder_rules'))
    state.reminderRules = new Map(
      rows('reminder_rules').map((r) => {
        const { spec_json, ...rest } = r;
        const row = { ...rest, spec: JSON.parse(String(spec_json)) } as unknown as ReminderRule;
        return [row.id, row];
      }),
    );
  if (include.includes('attachment_links')) {
    const mediaIds = entityIds
      ? [...new Set([...(state.attachmentLinks?.values() ?? [])].map((l) => l.media_id))]
      : [];
    state.mediaAnnotations = new Map();
    for (let start = 0; start < mediaIds.length; start += 80) {
      const ids = mediaIds.slice(start, start + 80);
      const annotations = (
        await db
          .prepare(
            `SELECT * FROM media_annotations WHERE workspace_id = ? AND media_id IN (${ids.map(() => '?').join(',')})`,
          )
          .bind(workspaceId, ...ids)
          .all<import('@otis/contracts').MediaAnnotation>()
      ).results;
      for (const row of annotations) state.mediaAnnotations.set(row.media_id, row);
    }
    // Whole-workspace replay also retains annotations after their client is removed.
    if (!entityIds)
      state.mediaAnnotations = new Map(
        (
          await db
            .prepare('SELECT * FROM media_annotations WHERE workspace_id = ?')
            .bind(workspaceId)
            .all<import('@otis/contracts').MediaAnnotation>()
        ).results.map((row) => [row.media_id, row]),
      );
  }
}

/** Changed-only persistence; primary demotions run before promotions in the same guarded batch. */
export function businessDetailStatements(
  db: D1Database,
  before: LedgerProjectionState,
  after: LedgerProjectionState,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  const maps = [before.contacts, before.redirects, before.attachmentLinks, before.reminderRules];
  const nextMaps = [after.contacts, after.redirects, after.attachmentLinks, after.reminderRules];
  for (let n = 0; n < tables.length; n++) {
    const prior = maps[n] as
      | Map<string, EntityContact | EntityRedirect | AttachmentLink | ReminderRule>
      | undefined;
    const next = nextMaps[n] as typeof prior;
    const table = tables[n]!;
    for (const [id, row] of prior ?? [])
      if (!next?.has(id))
        statements.push(
          db
            .prepare(
              `DELETE FROM ${table} WHERE workspace_id = ? AND ${n === 1 ? 'source_entity_id' : 'id'} = ?`,
            )
            .bind(row.workspace_id, id),
        );
    if (n === 3)
      for (const [id, row] of prior ?? [])
        if (!next?.has(id))
          statements.push(
            db
              .prepare(
                "UPDATE reminders SET status = 'cancelled', last_error = 'Follow-up was undone.', updated_at = ? WHERE workspace_id = ? AND rule_id = ? AND status = 'pending'",
              )
              .bind(new Date().toISOString(), row.workspace_id, id),
          );
    const changed = [...(next?.entries() ?? [])].filter(
      ([id, row]) => JSON.stringify(prior?.get(id)) !== JSON.stringify(row),
    );
    if (n === 0)
      changed.sort(
        ([, a], [, b]) =>
          Number((a as EntityContact).is_primary) - Number((b as EntityContact).is_primary),
      );
    for (const [, item] of changed) {
      if (n === 0) {
        const c = item as EntityContact;
        statements.push(
          db
            .prepare(
              `INSERT INTO entity_contacts (id, workspace_id, entity_id, method, value, comparison_key, label, is_primary, state, revision, source_event_id, original_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET value=excluded.value, comparison_key=excluded.comparison_key, label=excluded.label, is_primary=excluded.is_primary, state=excluded.state, revision=excluded.revision, source_event_id=excluded.source_event_id, updated_at=excluded.updated_at`,
            )
            .bind(
              c.id,
              c.workspace_id,
              c.entity_id,
              c.method,
              c.value,
              c.comparison_key,
              c.label,
              Number(c.is_primary),
              c.state,
              c.revision,
              c.source_event_id,
              c.original_event_id,
              c.updated_at,
            ),
        );
      } else if (n === 1) {
        const r = item as EntityRedirect;
        statements.push(
          db
            .prepare(
              `INSERT INTO entity_redirects (workspace_id, source_entity_id, target_entity_id, source_event_id, decisions_json, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, source_entity_id) DO UPDATE SET target_entity_id=excluded.target_entity_id, source_event_id=excluded.source_event_id, decisions_json=excluded.decisions_json, revision=excluded.revision, updated_at=excluded.updated_at`,
            )
            .bind(
              r.workspace_id,
              r.source_entity_id,
              r.target_entity_id,
              r.source_event_id,
              JSON.stringify(r.decisions),
              r.revision,
              r.updated_at,
            ),
        );
      } else if (n === 2) {
        const l = item as AttachmentLink;
        statements.push(
          db
            .prepare(
              `INSERT INTO attachment_links (id, workspace_id, entity_id, interaction_id, media_id, label, state, revision, source_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET label=excluded.label, state=excluded.state, revision=excluded.revision, source_event_id=excluded.source_event_id, updated_at=excluded.updated_at`,
            )
            .bind(
              l.id,
              l.workspace_id,
              l.entity_id,
              l.interaction_id,
              l.media_id,
              l.label,
              l.state,
              l.revision,
              l.source_event_id,
              l.updated_at,
            ),
        );
      } else {
        const r = item as ReminderRule;
        statements.push(
          db
            .prepare(
              `INSERT INTO reminder_rules (id, workspace_id, user_id, entity_id, text, timezone, channel, spec_json, status, revision, source_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET entity_id=excluded.entity_id, text=excluded.text, timezone=excluded.timezone, channel=excluded.channel, spec_json=excluded.spec_json, status=excluded.status, revision=excluded.revision, source_event_id=excluded.source_event_id, updated_at=excluded.updated_at`,
            )
            .bind(
              r.id,
              r.workspace_id,
              r.user_id,
              r.entity_id,
              r.text,
              r.timezone,
              r.channel,
              JSON.stringify(r.spec),
              r.status,
              r.revision,
              r.source_event_id,
              r.updated_at,
            ),
        );
        statements.push(
          db
            .prepare(
              `INSERT INTO reminder_rule_cursors(rule_id, workspace_id, rule_revision, next_due, dirty, updated_at) VALUES (?, ?, ?, NULL, 1, ?)
          ON CONFLICT(rule_id) DO UPDATE SET rule_revision = excluded.rule_revision, next_due = NULL, dirty = 1, updated_at = excluded.updated_at`,
            )
            .bind(r.id, r.workspace_id, r.revision, r.updated_at),
        );
        statements.push(
          db
            .prepare(
              "UPDATE reminders SET status = 'cancelled', last_error = 'Follow-up changed.', updated_at = ? WHERE workspace_id = ? AND rule_id = ? AND status = 'pending' AND (rule_revision != ? OR ? != 'active')",
            )
            .bind(r.updated_at, r.workspace_id, r.id, r.revision, r.status),
        );
      }
    }
  }
  const mediaIds = new Map<string, string>();
  for (const [id, annotation] of before.mediaAnnotations ?? [])
    if (!after.mediaAnnotations?.has(id)) {
      statements.push(
        db
          .prepare('DELETE FROM media_annotations WHERE workspace_id = ? AND media_id = ?')
          .bind(annotation.workspace_id, id),
      );
      mediaIds.set(id, annotation.workspace_id);
    }
  for (const [id, annotation] of after.mediaAnnotations ?? [])
    if (JSON.stringify(before.mediaAnnotations?.get(id)) !== JSON.stringify(annotation)) {
      statements.push(
        db
          .prepare(
            `INSERT INTO media_annotations(media_id, workspace_id, transcript, retention, release_after, revision, source_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(media_id) DO UPDATE SET transcript=excluded.transcript, retention=excluded.retention, release_after=excluded.release_after, revision=excluded.revision, source_event_id=excluded.source_event_id, updated_at=excluded.updated_at`,
          )
          .bind(
            id,
            annotation.workspace_id,
            annotation.transcript,
            annotation.retention,
            annotation.release_after,
            annotation.revision,
            annotation.source_event_id,
            annotation.updated_at,
          ),
      );
      mediaIds.set(id, annotation.workspace_id);
    }
  for (const map of [before.attachmentLinks, after.attachmentLinks])
    for (const [id, link] of map ?? [])
      if (
        JSON.stringify(before.attachmentLinks?.get(id)) !==
        JSON.stringify(after.attachmentLinks?.get(id))
      )
        mediaIds.set(link.media_id, link.workspace_id);
  // Removing a client is reversible; it must not release its historical originals.
  // Undoing the original link, in contrast, restores the previous unretained state.
  const deletedClientMedia = new Set(
    [...(before.attachmentLinks?.values() ?? [])]
      .filter((link) => before.entities.has(link.entity_id) && !after.entities.has(link.entity_id))
      .map((link) => link.media_id),
  );
  for (const [id, workspaceId] of mediaIds)
    statements.push(
      db
        .prepare(
          `UPDATE media_objects SET
    retained = CASE WHEN EXISTS (SELECT 1 FROM attachment_links l WHERE l.workspace_id = media_objects.workspace_id AND l.media_id = media_objects.id AND l.state = 'active') THEN 1
      WHEN COALESCE((SELECT retention FROM media_annotations a WHERE a.workspace_id = media_objects.workspace_id AND a.media_id = media_objects.id), 'inherit') = 'release' THEN 0
      WHEN EXISTS (SELECT 1 FROM attachment_links l WHERE l.workspace_id = media_objects.workspace_id AND l.media_id = media_objects.id)
        OR EXISTS (SELECT 1 FROM media_annotations a WHERE a.workspace_id = media_objects.workspace_id AND a.media_id = media_objects.id AND a.retention = 'retain') THEN 1 ELSE ? END,
    expires_at = COALESCE((SELECT release_after FROM media_annotations a WHERE a.workspace_id = media_objects.workspace_id AND a.media_id = media_objects.id AND a.retention = 'release'), expires_at)
    WHERE workspace_id = ? AND id = ?`,
        )
        .bind(Number(deletedClientMedia.has(id)), workspaceId, id),
    );
  return statements;
}

import { WORKSPACE_CANONICAL_SQL } from './canonical.js';

/** Effective contact evidence, including legacy events without an interaction projection. */
export async function readEffectiveLastContacts(db: D1Database, workspace: string, ids: string[]) {
  const contacts = new Map<string, { at: string; eventId: string }>();
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    const rows = (await db.prepare(`${WORKSPACE_CANONICAL_SQL} SELECT entity_id, id, occurred_at FROM (
      SELECT em.entity_id, e.id, e.occurred_at,
        ROW_NUMBER() OVER (PARTITION BY em.entity_id ORDER BY e.occurred_at DESC, e.id DESC) AS rn
      FROM events e JOIN entity_map em ON em.origin_id = e.entity_id
      WHERE e.workspace_id = ? AND em.entity_id IN (${chunk.map(() => '?').join(',')})
        AND (e.kind IN ('contact', 'message_sent_by_member') OR (e.kind = 'visit' AND json_extract(e.payload_json, '$.contact_made') = 1))
        AND NOT EXISTS (SELECT 1 FROM events r WHERE r.workspace_id = e.workspace_id AND r.kind = 'revert'
          AND (r.reverts_event_id = e.id OR json_extract(r.payload_json, '$.target_event_id') = e.id))
        AND NOT EXISTS (SELECT 1 FROM events s WHERE s.workspace_id = e.workspace_id AND s.entity_id = e.entity_id AND s.supersedes_event_id = e.id
          AND NOT EXISTS (SELECT 1 FROM events r WHERE r.workspace_id = s.workspace_id AND r.kind = 'revert' AND (r.reverts_event_id = s.id OR json_extract(r.payload_json, '$.target_event_id') = s.id)))
        AND NOT EXISTS (SELECT 1 FROM events d WHERE d.workspace_id = e.workspace_id AND d.entity_id = e.entity_id AND d.kind = 'interaction_removed'
          AND json_extract(d.payload_json, '$.root_event_id') = COALESCE(json_extract(e.payload_json, '$.interaction_id'), e.id)
          AND NOT EXISTS (SELECT 1 FROM events r WHERE r.workspace_id = d.workspace_id AND r.kind = 'revert' AND (r.reverts_event_id = d.id OR json_extract(r.payload_json, '$.target_event_id') = d.id)))
    ) WHERE rn = 1`).bind(workspace, workspace, workspace, workspace, ...chunk).all<{ entity_id: string; id: string; occurred_at: string }>()).results ?? [];
    for (const row of rows) if (Number.isFinite(Date.parse(row.occurred_at))) contacts.set(row.entity_id, { at: row.occurred_at, eventId: row.id });
  }
  return contacts;
}

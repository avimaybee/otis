import type { CurrentInteraction, InteractionKind } from '@otis/contracts';
import { ENTITY_FAMILY_SQL, familyBinds } from './canonical.js';

export const CURRENT_INTERACTION_COLUMNS = `i.root_event_id, i.head_event_id, i.entity_id, i.kind,
  i.revision, i.occurred_at, i.sequence, e.payload_json, e.actor_kind, e.actor_user_id,
  e.channel, e.source_message_id, e.recorded_at, e.provenance,
  ent.name AS entity_name, u.display_name AS actor_name,
  root.actor_user_id AS original_actor_user_id, reporter.display_name AS original_actor_name,
  root.source_message_id AS original_source_message_id, root.recorded_at AS original_recorded_at`;
export const CURRENT_INTERACTION_JOINS = `FROM interaction_state i
  JOIN events e ON e.workspace_id = i.workspace_id AND e.id = i.head_event_id
  LEFT JOIN entities ent ON ent.workspace_id = i.workspace_id AND ent.id = i.entity_id
  LEFT JOIN users u ON u.id = e.actor_user_id
  JOIN events root ON root.workspace_id = i.workspace_id AND root.id = i.root_event_id
  LEFT JOIN users reporter ON reporter.id = root.actor_user_id`;

export function mapCurrentInteraction(row: Record<string, unknown>): CurrentInteraction {
  const payload = JSON.parse(String(row['payload_json'])) as Record<string, unknown>;
  // The root is a separate trusted identifier; internal linkage is not editable content.
  delete payload['interaction_id'];
  return {
    interaction_id: String(row['root_event_id']), head_event_id: String(row['head_event_id']),
    entity_id: row['entity_id'] ? String(row['entity_id']) : null,
    entity_name: row['entity_name'] ? String(row['entity_name']) : null,
    kind: row['kind'] as InteractionKind, revision: Number(row['revision']),
    occurred_at: String(row['occurred_at']), sequence: Number(row['sequence']), payload,
    actor_kind: String(row['actor_kind']), actor_user_id: row['actor_user_id'] ? String(row['actor_user_id']) : null,
    actor_name: row['actor_name'] ? String(row['actor_name']) : null,
    channel: String(row['channel']), source_message_id: row['source_message_id'] ? String(row['source_message_id']) : null,
    recorded_at: String(row['recorded_at']), provenance: String(row['provenance']),
    original_actor_user_id: row['original_actor_user_id'] ? String(row['original_actor_user_id']) : null,
    original_actor_name: row['original_actor_name'] ? String(row['original_actor_name']) : null,
    original_source_message_id: row['original_source_message_id'] ? String(row['original_source_message_id']) : null,
    original_recorded_at: String(row['original_recorded_at']),
  };
}

/** Effective entries, never unqualified historical reports. Caller supplies trusted workspace identity. */
export async function readCurrentInteractions(db: D1Database, workspaceId: string, options: {
  entity_id?: string; interaction_id?: string; kind?: InteractionKind; text?: string;
  limit?: number; cursor?: string; author_user_id?: string; from?: string; to?: string;
} = {}): Promise<{ rows: CurrentInteraction[]; next_cursor: string | null; has_more: boolean }> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid interaction page limit.');
  if (options.cursor !== undefined && (!/^\d+$/.test(options.cursor) || !Number.isSafeInteger(Number(options.cursor)))) {
    throw new Error('Invalid interaction cursor.');
  }
  const predicates = ["i.workspace_id = ?", "i.state = 'active'", '(i.entity_id IS NULL OR ent.id IS NOT NULL)'];
  const binds: (string | number)[] = [workspaceId];
  if (options.entity_id) { predicates.push('i.entity_id IN (SELECT id FROM family)'); }
  for (const [column, value] of [['root_event_id', options.interaction_id], ['kind', options.kind]] as const) {
    if (value !== undefined) { predicates.push(`i.${column} = ?`); binds.push(value); }
  }
  if (options.author_user_id) { predicates.push('(e.actor_user_id = ? OR root.actor_user_id = ?)'); binds.push(options.author_user_id, options.author_user_id); }
  if (options.from) { predicates.push('i.occurred_at >= ?'); binds.push(options.from); }
  if (options.to) { predicates.push('i.occurred_at < ?'); binds.push(options.to); }
  if (options.text !== undefined) {
    predicates.push("e.payload_json LIKE ? ESCAPE '\\'");
    binds.push(`%${options.text.replace(/[\\%_]/g, '\\$&')}%`);
  }
  if (options.cursor !== undefined) { predicates.push('i.sequence < ?'); binds.push(Number(options.cursor)); }
  binds.push(limit + 1);
  const result = await db.prepare(`${options.entity_id ? ENTITY_FAMILY_SQL : ''} SELECT ${CURRENT_INTERACTION_COLUMNS} ${CURRENT_INTERACTION_JOINS}
    WHERE ${predicates.join(' AND ')} ORDER BY i.sequence DESC LIMIT ?`).bind(...options.entity_id ? familyBinds(workspaceId, options.entity_id) : [], ...binds).all<Record<string, unknown>>();
  const found = result.results ?? [];
  const rows = found.slice(0, limit).map(mapCurrentInteraction);
  const has_more = found.length > limit;
  return { rows, has_more, next_cursor: has_more ? String(rows.at(-1)!.sequence) : null };
}

/** Bulk policy resolves model root IDs to trusted workspace entity IDs in bounded batches. */
export async function resolveInteractionEntities(db: D1Database, workspaceId: string, rootIds: string[]): Promise<Map<string, string>> {
  const roots = [...new Set(rootIds)];
  const result = new Map<string, string>();
  for (let offset = 0; offset < roots.length; offset += 90) {
    const chunk = roots.slice(offset, offset + 90);
    const rows = await db.prepare(`SELECT root_event_id, entity_id FROM interaction_state
      WHERE workspace_id = ? AND state = 'active' AND entity_id IS NOT NULL
        AND root_event_id IN (${chunk.map(() => '?').join(',')})`).bind(workspaceId, ...chunk).all<{ root_event_id: string; entity_id: string }>();
    for (const row of rows.results ?? []) result.set(row.root_event_id, row.entity_id);
  }
  return result;
}

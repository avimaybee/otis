import { ENTITY_FAMILY_SQL, familyBinds } from '@otis/ledger';
export { ENTITY_FAMILY_SQL, familyBinds } from '@otis/ledger';
/** Set-based identity mapping for explicitly requested workspace lists. */
export const WORKSPACE_CANONICAL_SQL = `WITH RECURSIVE entity_path(origin_id, entity_id, depth) AS (
  SELECT id, id, 0 FROM entities WHERE workspace_id = ?
  UNION ALL SELECT p.origin_id, r.target_entity_id, p.depth + 1 FROM entity_path p
    JOIN entity_redirects r ON r.workspace_id = ? AND r.source_entity_id = p.entity_id WHERE p.depth < 32
), entity_map AS (SELECT origin_id, entity_id FROM entity_path p
  WHERE NOT EXISTS (SELECT 1 FROM entity_redirects r WHERE r.source_entity_id = p.entity_id AND r.workspace_id = ?)) `;
/** Shared mapping for bounded candidate sets, not one database read per row. */
export async function canonicalEntityMap(db: D1Database, workspace: string, ids: string[]): Promise<Map<string, { id: string; name: string }>> {
  const result = new Map<string, { id: string; name: string }>();
  const unique = [...new Set(ids)];
  for (let at = 0; at < unique.length; at += 80) {
    const chunk = unique.slice(at, at + 80);
    const rows = (await db.prepare(`WITH RECURSIVE chain(origin, id, depth) AS (SELECT id, id, 0 FROM entities WHERE workspace_id = ? AND id IN (${chunk.map(() => '?').join(',')})
      UNION ALL SELECT c.origin, r.target_entity_id, c.depth + 1 FROM chain c JOIN entity_redirects r ON r.workspace_id = ? AND r.source_entity_id = c.id WHERE c.depth < 32)
      SELECT c.origin, e.id, e.name FROM chain c JOIN entities e ON e.workspace_id = ? AND e.id = c.id
      WHERE NOT EXISTS (SELECT 1 FROM entity_redirects r WHERE r.workspace_id = e.workspace_id AND r.source_entity_id = e.id)`)
      .bind(workspace, ...chunk, workspace, workspace).all<{ origin: string; id: string; name: string }>()).results ?? [];
    for (const r of rows) result.set(r.origin, { id: r.id, name: r.name });
  }
  return result;
}
export async function canonicalEntityId(db: D1Database, workspaceId: string, entityId: string): Promise<string | null> {
  const row = await db.prepare(`${ENTITY_FAMILY_SQL} SELECT e.id FROM entities e JOIN canonical c ON c.id = e.id WHERE e.workspace_id = ?`).bind(...familyBinds(workspaceId, entityId), workspaceId).first<{ id: string }>();
  return row?.id ?? null;
}

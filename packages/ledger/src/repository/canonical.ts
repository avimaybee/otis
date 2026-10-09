export const ENTITY_FAMILY_SQL = `WITH RECURSIVE ancestors(id, depth) AS (
  SELECT id, 0 FROM entities WHERE workspace_id = ? AND id = ?
  UNION ALL SELECT r.target_entity_id, a.depth + 1 FROM entity_redirects r JOIN ancestors a ON a.id = r.source_entity_id
    WHERE r.workspace_id = ? AND a.depth < 32
), canonical(id) AS (
  SELECT a.id FROM ancestors a WHERE NOT EXISTS (SELECT 1 FROM entity_redirects r WHERE r.workspace_id = ? AND r.source_entity_id = a.id)
), family(id, depth) AS (
  SELECT id, 0 FROM canonical
  UNION ALL SELECT r.source_entity_id, f.depth + 1 FROM entity_redirects r JOIN family f ON f.id = r.target_entity_id
    WHERE r.workspace_id = ? AND f.depth < 32
)`;
export const familyBinds = (workspaceId: string, entityId: string) => [workspaceId, entityId, workspaceId, workspaceId, workspaceId];

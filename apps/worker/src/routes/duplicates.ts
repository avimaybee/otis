/**
 * Duplicate Entity Detection Route
 * GET /api/workspaces/:workspaceId/duplicates
 */

import { normalizeName, levenshteinDistance } from '@otis/ledger';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { requireWorkspaceScope } from './scope.js';

export async function handleGetDuplicates(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;

  try {
    const { results: allEntities } = await env.DB
      .prepare(
        `SELECT id, name, kind, status,
                (SELECT value_text FROM entity_state s WHERE s.workspace_id = entities.workspace_id AND s.entity_id = entities.id AND s.field_name = 'company' AND s.state = 'clear') AS company
         FROM entities
         WHERE workspace_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM entity_redirects redirect
             WHERE redirect.workspace_id = entities.workspace_id
               AND redirect.source_entity_id = entities.id
           )
         ORDER BY name ASC LIMIT 100`,
      )
      .bind(workspaceId)
      .all<{ id: string; name: string; kind?: string | null; status?: string | null; company?: string | null }>();

    const candidates: Array<{
      entity_a: { id: string; name: string; kind?: string | null; status?: string | null; company?: string | null };
      entity_b: { id: string; name: string; kind?: string | null; status?: string | null; company?: string | null };
      similarity: number;
      reason: string;
    }> = [];

    const ents = allEntities ?? [];
    for (let i = 0; i < ents.length; i++) {
      for (let j = i + 1; j < ents.length; j++) {
        const ea = ents[i]!;
        const eb = ents[j]!;
        const normA = normalizeName(ea.name);
        const normB = normalizeName(eb.name);
        if (!normA || !normB) continue;

        const maxLen = Math.max(normA.length, normB.length);
        const dist = levenshteinDistance(normA, normB);
        const score = 1 - dist / maxLen;

        const isSubstring = (normA.length >= 3 && normB.includes(normA)) || (normB.length >= 3 && normA.includes(normB));

        if (score >= 0.75 || (isSubstring && Math.abs(normA.length - normB.length) <= 5)) {
          candidates.push({
            entity_a: ea,
            entity_b: eb,
            similarity: Math.round(Math.max(score, isSubstring ? 0.8 : 0) * 100) / 100,
            reason: score >= 0.9 ? 'Nearly identical names' : isSubstring ? 'Name variation or suffix' : 'Similar spelling',
          });
        }
      }
    }

    return jsonSuccess({
      candidates: candidates.slice(0, 20),
      total_candidates: candidates.length,
    }, 200, { 'x-request-id': requestId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(500, 'duplicates_error', `Failed to find duplicates: ${msg}`, requestId);
  }
}

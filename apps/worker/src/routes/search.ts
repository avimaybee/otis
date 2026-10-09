/**
 * Unified Workspace Search Route
 * GET /api/workspaces/:workspaceId/search?q=...&limit=...
 */

import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { requireWorkspaceScope } from './scope.js';
import { unifiedWorkspaceSearch } from '../unifiedSearch.js';

export async function handleUnifiedSearch(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;

  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 5), 20) : 5;

  try {
    const results = await unifiedWorkspaceSearch(env.DB, workspaceId, scope.user.id, q, limit);
    return jsonSuccess(results, 200, { 'x-request-id': requestId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(500, 'search_error', `Search failed: ${msg}`, requestId);
  }
}

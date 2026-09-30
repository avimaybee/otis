/**
 * Workspace routes: GET /api/workspaces/:workspaceId
 */

import type { WorkspaceDetailResponse } from '@otis/contracts';
import {
  extractSessionToken,
  verifySession,
  checkMembership,
  getWorkspace,
} from '@otis/identity';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';

export async function handleGetWorkspace(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const token = extractSessionToken(request);
  if (!token) {
    return jsonError(401, 'unauthorized', 'Authentication session required.', requestId);
  }

  const verified = await verifySession(env.DB, token);
  if (!verified) {
    return jsonError(401, 'session_expired', 'Session is invalid or expired.', requestId);
  }

  // Enforce membership check; 404 for out-of-scope lookups
  const membership = await checkMembership(env.DB, workspaceId, verified.user.id);
  if (!membership) {
    return jsonError(
      404,
      'workspace_not_found',
      'Workspace not found or access denied.',
      requestId,
    );
  }

  const workspace = await getWorkspace(env.DB, workspaceId);
  if (!workspace) {
    return jsonError(
      404,
      'workspace_not_found',
      'Workspace not found or access denied.',
      requestId,
    );
  }

  const responseBody: WorkspaceDetailResponse = {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      role: membership.role,
      business_revision: workspace.business_revision,
      created_at: workspace.created_at,
    },
  };

  return jsonSuccess(responseBody, 200, { 'x-request-id': requestId });
}

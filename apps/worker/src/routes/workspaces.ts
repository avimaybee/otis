/**
 * Workspace routes: GET /api/workspaces/:workspaceId
 */

import type { WorkspaceDetailResponse } from '@otis/contracts';
import {
  extractSessionToken,
  verifySession,
  checkMembership,
  getWorkspace,
  validateCsrfAndOrigin,
  createWorkspace,
  updateWorkspaceName,
  deleteWorkspace,
} from '@otis/identity';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { readJsonBody, requireWorkspaceScope } from './scope.js';

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

export async function handleCreateWorkspace(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  if (!validateCsrfAndOrigin(request)) {
    return jsonError(403, 'csrf_violation', 'Cross-origin request rejected.', requestId);
  }
  const token = extractSessionToken(request);
  if (!token) {
    return jsonError(401, 'unauthorized', 'Authentication session required.', requestId);
  }

  const verified = await verifySession(env.DB, token);
  if (!verified) {
    return jsonError(401, 'session_expired', 'Session is invalid or expired.', requestId);
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok || typeof parsed.body['name'] !== 'string' || !parsed.body['name'].trim()) {
    return jsonError(422, 'invalid_payload', 'A valid workspace name is required.', requestId);
  }

  const name = parsed.body['name'].trim();
  try {
    const ws = await createWorkspace(env.DB, { name, ownerUserId: verified.user.id });
    return jsonSuccess({ workspace: ws }, 201, { 'x-request-id': requestId });
  } catch (err) {
    return jsonError(400, 'workspace_creation_failed', err instanceof Error ? err.message : String(err), requestId);
  }
}

export async function handleUpdateWorkspace(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;

  const parsed = await readJsonBody(request);
  if (!parsed.ok || typeof parsed.body['name'] !== 'string' || !parsed.body['name'].trim()) {
    return jsonError(422, 'invalid_payload', 'A valid workspace name is required.', requestId);
  }

  try {
    const ws = await updateWorkspaceName(env.DB, {
      workspaceId,
      name: parsed.body['name'].trim(),
      actorUserId: scope.user.id,
    });
    return jsonSuccess({ workspace: ws }, 200, { 'x-request-id': requestId });
  } catch (err) {
    return jsonError(403, 'workspace_update_failed', err instanceof Error ? err.message : String(err), requestId);
  }
}

export async function handleDeleteWorkspace(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;

  try {
    const result = await deleteWorkspace(env.DB, {
      workspaceId,
      actorUserId: scope.user.id,
    });
    return jsonSuccess(result, 200, { 'x-request-id': requestId });
  } catch (err) {
    return jsonError(403, 'workspace_delete_failed', err instanceof Error ? err.message : String(err), requestId);
  }
}

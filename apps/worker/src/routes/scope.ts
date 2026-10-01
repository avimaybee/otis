/**
 * Shared scope helper for workspace routes: session verification plus
 * current membership recheck. Returns the user/membership or an error
 * Response (401 no session, 404 out-of-scope).
 */

import type { User, WorkspaceMember } from '@otis/contracts';
import {
  checkMembership,
  extractSessionToken,
  validateCsrfAndOrigin,
  verifySession,
} from '@otis/identity';
import { jsonError } from '../middleware/errors.js';

export interface WorkspaceScope {
  user: User;
  membership: WorkspaceMember;
}

export async function requireWorkspaceScope(
  request: Request,
  db: D1Database,
  workspaceId: string,
  requestId: string,
  options?: { csrf?: boolean },
): Promise<WorkspaceScope | Response> {
  if (options?.csrf && !validateCsrfAndOrigin(request)) {
    return jsonError(403, 'csrf_violation', 'Cross-origin request rejected.', requestId);
  }
  const token = extractSessionToken(request);
  if (!token) {
    return jsonError(401, 'unauthorized', 'Authentication session required.', requestId);
  }
  const verified = await verifySession(db, token);
  if (!verified) {
    return jsonError(401, 'session_expired', 'Session is invalid or expired.', requestId);
  }
  const membership = await checkMembership(db, workspaceId, verified.user.id);
  if (!membership) {
    return jsonError(404, 'workspace_not_found', 'Workspace not found or access denied.', requestId);
  }
  return { user: verified.user, membership };
}

export async function readJsonBody(request: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (!body || typeof body !== 'object') return { ok: false };
    return { ok: true, body };
  } catch {
    return { ok: false };
  }
}

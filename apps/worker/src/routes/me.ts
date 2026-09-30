/**
 * GET /api/me route. Returns authenticated identity and member workspaces.
 */

import type { MeResponse } from '@otis/contracts';
import { extractSessionToken, verifySession, getUserWorkspaces } from '@otis/identity';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';

export async function handleGetMe(
  request: Request,
  env: Env,
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

  const workspaces = await getUserWorkspaces(env.DB, verified.user.id);
  const responseBody: MeResponse = {
    user: verified.user,
    workspaces,
  };

  return jsonSuccess(responseBody, 200, { 'x-request-id': requestId });
}

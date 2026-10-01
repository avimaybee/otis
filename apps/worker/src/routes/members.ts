/**
 * Workspace lifecycle routes: invites, member list, remove, leave, transfer.
 * Every route rechecks current membership; removed members get 404 with no
 * existence leak. Mutations require the CSRF/origin check.
 */

import type {
  CreateInviteResponse,
  LifecycleActionResponse,
  MemberListResponse,
  TransferOwnershipRequest,
} from '@otis/contracts';
import {
  createInvite,
  InviteError,
  leaveWorkspace,
  LifecycleError,
  listMembers,
  removeMember,
  transferOwnership,
} from '@otis/identity';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { readJsonBody, requireWorkspaceScope } from './scope.js';

function lifecycleStatus(code: string): number {
  switch (code) {
    case 'not_member':
    case 'target_not_member':
      return 404;
    case 'not_owner':
    case 'cannot_remove_owner':
    case 'owner_must_transfer':
    case 'last_member':
      return 403;
    case 'concurrent_change':
      return 409;
    default:
      return 400;
  }
}

function lifecycleErrorResponse(err: LifecycleError, requestId: string): Response {
  return jsonError(lifecycleStatus(err.code), err.code, err.message, requestId);
}

export async function handleCreateInvite(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;

  const parsed = await readJsonBody(request);
  if (!parsed.ok || typeof parsed.body['email'] !== 'string' || !parsed.body['email'].trim()) {
    return jsonError(422, 'invalid_payload', 'A valid invite email is required.', requestId);
  }

  try {
    const invite = await createInvite(env.DB, {
      workspaceId,
      invitedEmail: parsed.body['email'].trim(),
      invitedByUserId: scope.user.id,
    });
    const responseBody: CreateInviteResponse = {
      status: 'ok',
      invite_id: invite.inviteId,
      token: invite.token,
      expires_at: invite.expiresAt,
    };
    return jsonSuccess(responseBody, 201, { 'x-request-id': requestId });
  } catch (err) {
    if (err instanceof InviteError) {
      if (err.code === 'not_member') {
        return jsonError(404, err.code, err.message, requestId);
      }
      return jsonError(400, err.code, err.message, requestId);
    }
    throw err;
  }
}

export async function handleListMembers(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;

  const members = await listMembers(env.DB, workspaceId);
  const responseBody: MemberListResponse = { members };
  return jsonSuccess(responseBody, 200, { 'x-request-id': requestId });
}

export async function handleRemoveMember(
  request: Request,
  env: Env,
  workspaceId: string,
  targetUserId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;

  try {
    const result = await removeMember(env.DB, {
      workspaceId,
      actorUserId: scope.user.id,
      targetUserId,
    });
    const responseBody: LifecycleActionResponse = { status: 'ok', ...result };
    return jsonSuccess(responseBody, 200, { 'x-request-id': requestId });
  } catch (err) {
    if (err instanceof LifecycleError) return lifecycleErrorResponse(err, requestId);
    throw err;
  }
}

export async function handleLeaveWorkspace(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;

  try {
    const result = await leaveWorkspace(env.DB, { workspaceId, userId: scope.user.id });
    const responseBody: LifecycleActionResponse = { status: 'ok', ...result };
    return jsonSuccess(responseBody, 200, { 'x-request-id': requestId });
  } catch (err) {
    if (err instanceof LifecycleError) return lifecycleErrorResponse(err, requestId);
    throw err;
  }
}

export async function handleTransferOwnership(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;

  const parsed = await readJsonBody(request);
  const body = parsed.ok ? (parsed.body as unknown as TransferOwnershipRequest) : null;
  if (!body || typeof body.new_owner_user_id !== 'string' || !body.new_owner_user_id.trim()) {
    return jsonError(422, 'invalid_payload', 'new_owner_user_id is required.', requestId);
  }

  try {
    const result = await transferOwnership(env.DB, {
      workspaceId,
      actorUserId: scope.user.id,
      newOwnerUserId: body.new_owner_user_id.trim(),
    });
    const responseBody: LifecycleActionResponse = { status: 'ok', ...result };
    return jsonSuccess(responseBody, 200, { 'x-request-id': requestId });
  } catch (err) {
    if (err instanceof LifecycleError) return lifecycleErrorResponse(err, requestId);
    throw err;
  }
}

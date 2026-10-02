/**
 * Settings routes: shared workspace settings and personal member settings.
 * Members may read shared settings and read/update only their own member
 * settings. Mutations require the CSRF/origin check and write audit rows.
 */

import type {
  UpdateMemberSettingsRequest,
  UpdateWorkspaceSettingsRequest,
} from '@otis/contracts';
import {
  getMemberSettings,
  getWorkspaceSettings,
  setMemberSettings,
  SettingsError,
  setWorkspaceSettings,
} from '@otis/identity';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { validateWorkspaceDefaultModel } from '../providers/service.js';
import { readJsonBody, requireWorkspaceScope } from './scope.js';

export async function handleGetWorkspaceSettings(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;
  const settings = await getWorkspaceSettings(env.DB, workspaceId);
  return jsonSuccess({ status: 'ok', settings }, 200, { 'x-request-id': requestId });
}

export async function handleUpdateWorkspaceSettings(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return jsonError(422, 'invalid_payload', 'Request body must be valid JSON.', requestId);
  }
  const body = parsed.body as UpdateWorkspaceSettingsRequest;
  try {
    // Registry validation (Plan 005) happens before the committing path:
    // unknown, retired, unverified, or uncredentialed keys are rejected and
    // never stored. Null clears the default and stays valid.
    if (body.default_model !== undefined && body.default_model !== null) {
      await validateWorkspaceDefaultModel(env.DB, {
        workspaceId,
        actorUserId: scope.user.id,
        commandKey: body.default_model,
      });
    }
    const settings = await setWorkspaceSettings(env.DB, {
      workspaceId,
      actorUserId: scope.user.id,
      defaultModel: body.default_model,
    });
    return jsonSuccess({ status: 'ok', settings }, 200, { 'x-request-id': requestId });
  } catch (err) {
    if (err instanceof SettingsError) {
      if (err.code === 'not_member') {
        return jsonError(404, err.code, err.message, requestId);
      }
      return jsonError(422, err.code, err.message, requestId);
    }
    throw err;
  }
}

export async function handleGetMemberSettings(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;
  const settings = await getMemberSettings(env.DB, { workspaceId, userId: scope.user.id });
  return jsonSuccess({ status: 'ok', settings }, 200, { 'x-request-id': requestId });
}

export async function handleUpdateMemberSettings(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return jsonError(422, 'invalid_payload', 'Request body must be valid JSON.', requestId);
  }
  const body = parsed.body as UpdateMemberSettingsRequest;
  try {
    const settings = await setMemberSettings(env.DB, {
      workspaceId,
      userId: scope.user.id,
      actorUserId: scope.user.id,
      input: {
        brief_enabled: body.brief_enabled,
        brief_local_time: body.brief_local_time,
        brief_timezone: body.brief_timezone,
        brief_weekdays: body.brief_weekdays,
        brief_channel: body.brief_channel,
        preferred_language: body.preferred_language,
      },
    });
    return jsonSuccess({ status: 'ok', settings }, 200, { 'x-request-id': requestId });
  } catch (err) {
    if (err instanceof SettingsError) {
      if (err.code === 'not_member') {
        return jsonError(404, err.code, err.message, requestId);
      }
      return jsonError(422, err.code, err.message, requestId);
    }
    throw err;
  }
}

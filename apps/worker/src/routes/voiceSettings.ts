/**
 * @otis/worker/routes/voiceSettings
 * Shared workspace STT settings for Gate 010. Reads expose status only;
 * ciphertext, nonces and raw keys never cross this boundary. Mutations
 * require CSRF/origin validation and write an attributed audit row.
 */

import {
  VOICE_FORMATS,
  validateUpdateVoiceSettingsRequest,
  type UpdateWorkspaceVoiceSettingsRequest,
  type VoiceSettingsResponse,
} from '@otis/contracts';
import {
  getCredentialMetadata,
  getWorkspaceVoiceSettings,
  setWorkspaceVoiceSettings,
  VoiceSettingsError,
} from '@otis/identity';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { readJsonBody, requireWorkspaceScope } from './scope.js';

function toResponse(
  stored: Awaited<ReturnType<typeof getWorkspaceVoiceSettings>>,
  credentialStatus: string | null,
): VoiceSettingsResponse {
  return {
    status: 'ok',
    settings: {
      workspace_id: stored.workspace_id,
      enabled: stored.enabled,
      provider: stored.provider,
      model: stored.model,
      verified_formats: stored.verified_formats,
      transcription_verified: stored.verified_formats.length === VOICE_FORMATS.length,
      credential_status: (credentialStatus as VoiceSettingsResponse['settings']['credential_status']) ?? null,
    },
  };
}

export async function handleGetVoiceSettings(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;
  const stored = await getWorkspaceVoiceSettings(env.DB, workspaceId);
  const credential = await getCredentialMetadata(env.DB, { workspaceId, provider: 'groq' });
  return jsonSuccess(toResponse(stored, credential?.status ?? null), 200, { 'x-request-id': requestId });
}

export async function handleUpdateVoiceSettings(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return jsonError(422, 'invalid_payload', 'Request body must be valid JSON.', requestId);
  const validated = validateUpdateVoiceSettingsRequest(parsed.body);
  if (!validated.valid) return jsonError(422, 'validation_error', validated.message, requestId);
  const body: UpdateWorkspaceVoiceSettingsRequest = validated.value;
  try {
    const stored = await setWorkspaceVoiceSettings(env.DB, {
      workspaceId,
      actorUserId: scope.user.id,
      input: {
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
      },
    });
    const credential = await getCredentialMetadata(env.DB, { workspaceId, provider: 'groq' });
    return jsonSuccess(toResponse(stored, credential?.status ?? null), 200, { 'x-request-id': requestId });
  } catch (err) {
    if (err instanceof VoiceSettingsError) {
      const status = err.code === 'not_member' ? 404 : 422;
      return jsonError(status, err.code, err.message, requestId);
    }
    throw err;
  }
}

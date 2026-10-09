/**
 * @otis/worker/media/routes
 * Authenticated private voice media routes for Gate 010:
 *
 *   POST .../media/uploads                     bounded upload claim + ticket
 *   PUT  .../media/uploads/:mediaId/content    quarantine bytes -> private R2
 *   POST .../media/uploads/:mediaId/finalize   validate container/duration/route
 *   GET  .../media/:mediaId/status             transcript/status read
 *   GET  .../media/:mediaId                    private streaming/range read
 *
 * Quarantine objects are never readable through the normal route. Every read
 * and write rechecks current membership; no public R2 URL or bearer access is
 * exposed. Raw keys never enter responses or logs.
 */

import {
  IMAGE_BOUNDS,
  normalizeImageFormat,
  validateCreateImageUploadRequest,
  VOICE_BOUNDS,
  validateCreateVoiceUploadRequest,
  type CreateImageUploadResponse,
  type CreateVoiceUploadRequest,
  type CreateVoiceUploadResponse,
  type FinalizeVoiceUploadResponse,
  type VerifyVoiceFormatResponse,
  type VoiceMediaStatusResponse,
  type VoiceMediaSummary,
  type MediaFormat,
  type VoiceFormat,
} from '@otis/contracts';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { readJsonBody, requireWorkspaceScope } from '../routes/scope.js';
import { GROQ_STT_MODELS, transcribeWithGroq, type FetchFn, type VoiceRouteOutcome } from '@otis/agent';
import {
  decryptWorkspaceCredential,
  getCredentialMetadata,
  getWorkspaceVoiceSettings,
  importWrappingKey,
  recordVoiceFormatEvidence,
} from '@otis/identity';
import { extractPlatformKeys, resolveModelForChat, resolveVoiceRouteForWorkspace } from '../providers/service.js';
import { inspectAudioBytes, inspectImageBytes } from './container.js';
import { handleGetVoiceSettings, handleUpdateVoiceSettings } from '../routes/voiceSettings.js';
import {
  createMediaUpload,
  finalizeMediaValidation,
  findMediaByClientIdentity,
  hashUploadToken,
  loadMediaRow,
  loadTranscriptionRow,
  markMediaDeleted,
  markMediaExpired,
  markUploadBytesReceived,
  rejectMedia,
  resetMediaUploadForRetry,
  rotateMediaUploadTicket,
  toMediaSummary,
  type MediaRow,
} from './repository.js';

const UPLOAD_TOKEN_HEADER = 'x-otis-upload-token';

async function loadSummary(env: Env, workspaceId: string, mediaId: string): Promise<VoiceMediaSummary | null> {
  const row = await loadMediaRow(env.DB, workspaceId, mediaId);
  if (!row) return null;
  const transcription = await loadTranscriptionRow(env.DB, mediaId);
  return toMediaSummary(row as unknown as Record<string, unknown>, transcription);
}

/**
 * STT transport seam. Production dials the fixed endpoint through global
 * fetch; tests may inject a synthetic transport under the entrypoint's
 * declared test-only property so no test ever contacts Groq.
 */
function sttFetch(env: Env): FetchFn {
  const injected = (env as unknown as { TRANSCRIPTION_TEST_FETCH?: FetchFn }).TRANSCRIPTION_TEST_FETCH;
  return injected ?? ((url, init) => fetch(url, init));
}

async function requireChatAuthor(
  env: Env,
  workspaceId: string,
  chatId: string,
  userId: string,
): Promise<boolean> {
  const chat = await env.DB
    .prepare(`SELECT author_user_id FROM chats WHERE id = ? AND workspace_id = ?`)
    .bind(chatId, workspaceId)
    .first<{ author_user_id: string }>();
  return chat?.author_user_id === userId;
}

/**
 * Route availability for one upload. When the verified route is unavailable
 * but the workspace STT configuration and key are present, the upload is
 * accepted only as a server-side format-verification sample: the message
 * acceptance path still enforces the verified format.
 */
async function voiceUploadAvailability(
  env: Env,
  workspaceId: string,
  chatId: string,
  userId: string,
  format: string,
): Promise<{ route: VoiceRouteOutcome; verificationSample: boolean }> {
  const platformKeys = extractPlatformKeys(env);
  const model = await resolveModelForChat(env.DB, {
    workspaceId,
    actorUserId: userId,
    chatId,
    platformKeys,
  });
  const route = await resolveVoiceRouteForWorkspace(env.DB, {
    workspaceId,
    model: model.available ? model.entry : null,
    audioMimeOrExt: format,
    platformKeys,
  });
  if (route.route !== 'unavailable') return { route, verificationSample: false };
  const stored = await getWorkspaceVoiceSettings(env.DB, workspaceId);
  const credential = await getCredentialMetadata(env.DB, { workspaceId, provider: 'groq' });
  const hasGroq = credential?.status === 'available' || !!platformKeys.groq;
  const verificationSample = stored.enabled && stored.model !== null && hasGroq;
  return { route, verificationSample };
}

type ClaimReuseOutcome = 'reused' | 'finalized' | 'conflict';

/** Reuses one media identity for a retried claim; never creates a second object. */
async function reuseExistingClaim(
  env: Env,
  existing: MediaRow,
  params: {
    workspaceId: string;
    uploaderUserId: string;
    tokenHash: string;
    tokenExpiresAt: string;
    format: MediaFormat;
    contentType: string;
    durationMs: number;
    nowIso: string;
  },
): Promise<ClaimReuseOutcome> {
  if (existing.state === 'validated' || existing.state === 'transcribing' || existing.state === 'ready') {
    return 'finalized';
  }
  const ok =
    existing.state === 'quarantine'
      ? await rotateMediaUploadTicket(env.DB, { mediaId: existing.id, ...params })
      : await resetMediaUploadForRetry(env.DB, { mediaId: existing.id, ...params });
  return ok ? 'reused' : 'conflict';
}

function isUniqueViolation(err: unknown): boolean {
  const s = String(err);
  return s.includes('UNIQUE constraint failed') || s.includes('SQLITE_CONSTRAINT');
}

/**
 * Image claim on the same upload collection. Images skip the STT route
 * check entirely: they are prompt attachments, never transcription jobs.
 * One media lifecycle per stable client message UUID, mirroring voice.
 */
export async function handleCreateImageUpload(
  _request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
  scope: { user: { id: string } },
  rawBody: unknown,
): Promise<Response> {
  if (!env.STORAGE) {
    return jsonError(500, 'server_misconfigured', 'Private media storage is not configured.', requestId);
  }
  const validated = validateCreateImageUploadRequest(rawBody);
  if (!validated.valid) return jsonError(422, 'validation_error', validated.message, requestId);
  const body = validated.value;

  if (!(await requireChatAuthor(env, workspaceId, body.chat_id, scope.user.id))) {
    return jsonError(403, 'forbidden', 'Only the chat author can attach an image to this conversation.', requestId);
  }

  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await hashUploadToken(token);
  const nowIso = new Date().toISOString();
  const tokenExpiresAt = new Date(
    new Date(nowIso).getTime() + 15 * 60 * 1000,
  ).toISOString();

  const identity = {
    workspaceId,
    chatId: body.chat_id,
    uploaderUserId: scope.user.id,
    clientMessageId: body.client_message_id,
  };
  const reuseParams = {
    workspaceId,
    uploaderUserId: scope.user.id,
    tokenHash,
    tokenExpiresAt,
    format: body.content_type,
    contentType: body.content_type,
    durationMs: 0,
    nowIso,
  };
  let mediaId: string;
  const existing = await findMediaByClientIdentity(env.DB, identity);
  if (existing) {
    const outcome = await reuseExistingClaim(env, existing, reuseParams);
    if (outcome === 'finalized') {
      return jsonError(409, 'upload_already_finalized', 'This image was already uploaded.', requestId, false, {
        media_id: existing.id,
        state: existing.state,
      });
    }
    if (outcome === 'conflict') {
      return jsonError(409, 'upload_conflict', 'The upload state changed while claiming. Retry with the same message ID.', requestId);
    }
    mediaId = existing.id;
  } else {
    mediaId = `med_${crypto.randomUUID()}`;
    const objectKey = `workspace/${workspaceId}/media/${mediaId}`;
    try {
      await createMediaUpload(env.DB, {
        mediaId,
        workspaceId,
        chatId: body.chat_id,
        uploaderUserId: scope.user.id,
        clientMessageId: body.client_message_id,
        format: body.content_type,
        contentType: body.content_type,
        byteSize: body.byte_size,
        durationMs: 0,
        objectKey,
        tokenHash,
        tokenExpiresAt,
        nowIso,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await findMediaByClientIdentity(env.DB, identity);
      if (!raced) throw err;
      const outcome = await reuseExistingClaim(env, raced, reuseParams);
      if (outcome === 'finalized') {
        return jsonError(409, 'upload_already_finalized', 'This image was already uploaded.', requestId, false, {
          media_id: raced.id,
          state: raced.state,
        });
      }
      if (outcome === 'conflict') {
        return jsonError(409, 'upload_conflict', 'The upload state changed while claiming. Retry with the same message ID.', requestId);
      }
      mediaId = raced.id;
    }
  }

  const responseBody: CreateImageUploadResponse = {
    status: 'ok',
    media_id: mediaId,
    upload: {
      url: `/api/workspaces/${workspaceId}/media/uploads/${mediaId}/content`,
      token,
      expires_at: tokenExpiresAt,
    },
    limits: {
      max_bytes: IMAGE_BOUNDS.MAX_BYTES,
      formats: ['image/jpeg', 'image/png', 'image/webp'],
    },
  };
  return jsonSuccess(responseBody, 201, { 'x-request-id': requestId });
}

/**
 * POST /api/workspaces/:workspaceId/media/uploads
 */
export async function handleCreateVoiceUpload(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;
  if (!env.STORAGE) {
    return jsonError(500, 'server_misconfigured', 'Private media storage is not configured.', requestId);
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return jsonError(422, 'invalid_payload', 'Request body must be valid JSON.', requestId);
  const rawContentType =
    parsed.body && typeof parsed.body === 'object' && !Array.isArray(parsed.body)
      ? (parsed.body as Record<string, unknown>)['content_type']
      : null;
  if (typeof rawContentType === 'string' && normalizeImageFormat(rawContentType)) {
    return handleCreateImageUpload(request, env, workspaceId, requestId, scope, parsed.body);
  }
  const validated = validateCreateVoiceUploadRequest(parsed.body);
  if (!validated.valid) return jsonError(422, 'validation_error', validated.message, requestId);
  const body: CreateVoiceUploadRequest = validated.value;

  if (!(await requireChatAuthor(env, workspaceId, body.chat_id, scope.user.id))) {
    return jsonError(403, 'forbidden', 'Only the chat author can attach a voice note to this conversation.', requestId);
  }

  // Fail before bytes move when neither a verified route nor a verification
  // path exists for this container.
  const availability = await voiceUploadAvailability(env, workspaceId, body.chat_id, scope.user.id, body.content_type);
  if (availability.route.route === 'unavailable' && !availability.verificationSample) {
    return jsonError(422, 'voice_unavailable', availability.route.message, requestId);
  }

  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await hashUploadToken(token);
  const nowIso = new Date().toISOString();
  const tokenExpiresAt = new Date(
    new Date(nowIso).getTime() + VOICE_BOUNDS.UPLOAD_TTL_SECONDS * 1000,
  ).toISOString();

  // One media lifecycle per stable client message UUID: a retried claim
  // rotates the ticket on the existing row and its single R2 object instead
  // of orphaning another upload. Finalized media is never re-uploaded.
  const identity = {
    workspaceId,
    chatId: body.chat_id,
    uploaderUserId: scope.user.id,
    clientMessageId: body.client_message_id,
  };
  const reuseParams = {
    workspaceId,
    uploaderUserId: scope.user.id,
    tokenHash,
    tokenExpiresAt,
    format: body.content_type as VoiceFormat,
    contentType: body.content_type,
    durationMs: body.duration_ms,
    nowIso,
  };
  let mediaId: string;
  const existing = await findMediaByClientIdentity(env.DB, identity);
  if (existing) {
    const outcome = await reuseExistingClaim(env, existing, reuseParams);
    if (outcome === 'finalized') {
      return jsonError(409, 'upload_already_finalized', 'This recording was already uploaded.', requestId, false, {
        media_id: existing.id,
        state: existing.state,
      });
    }
    if (outcome === 'conflict') {
      return jsonError(409, 'upload_conflict', 'The upload state changed while claiming. Retry with the same message ID.', requestId);
    }
    mediaId = existing.id;
  } else {
    mediaId = `med_${crypto.randomUUID()}`;
    const objectKey = `workspace/${workspaceId}/media/${mediaId}`;
    try {
      await createMediaUpload(env.DB, {
        mediaId,
        workspaceId,
        chatId: body.chat_id,
        uploaderUserId: scope.user.id,
        clientMessageId: body.client_message_id,
        format: body.content_type as VoiceFormat,
        contentType: body.content_type,
        byteSize: body.byte_size,
        durationMs: body.duration_ms,
        objectKey,
        tokenHash,
        tokenExpiresAt,
        nowIso,
      });
    } catch (err) {
      // Concurrent claim with the same identity: reuse the winner's row.
      if (!isUniqueViolation(err)) throw err;
      const raced = await findMediaByClientIdentity(env.DB, identity);
      if (!raced) throw err;
      const outcome = await reuseExistingClaim(env, raced, reuseParams);
      if (outcome === 'finalized') {
        return jsonError(409, 'upload_already_finalized', 'This recording was already uploaded.', requestId, false, {
          media_id: raced.id,
          state: raced.state,
        });
      }
      if (outcome === 'conflict') {
        return jsonError(409, 'upload_conflict', 'The upload state changed while claiming. Retry with the same message ID.', requestId);
      }
      mediaId = raced.id;
    }
  }

  const media = await loadSummary(env, workspaceId, mediaId);
  const responseBody: CreateVoiceUploadResponse = {
    status: 'ok',
    media: media!,
    upload: {
      url: `/api/workspaces/${workspaceId}/media/uploads/${mediaId}/content`,
      token,
      expires_at: tokenExpiresAt,
    },
    limits: {
      max_bytes: VOICE_BOUNDS.MAX_BYTES,
      max_duration_seconds: VOICE_BOUNDS.MAX_DURATION_SECONDS,
      formats: ['audio/webm', 'audio/mp4', 'audio/ogg'],
    },
    verification_sample: availability.verificationSample,
  };
  return jsonSuccess(responseBody, 201, { 'x-request-id': requestId });
}

/** Reads at most maxBytes from the request body; never buffers beyond the cap. */
async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; code: 'too_large' | 'read_failed' }> {
  if (!request.body) return { ok: false, code: 'read_failed' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, code: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, code: 'read_failed' };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/**
 * PUT /api/workspaces/:workspaceId/media/uploads/:mediaId/content
 * Streams validated bytes into the private quarantine object.
 */
export async function handlePutVoiceUploadContent(
  request: Request,
  env: Env,
  workspaceId: string,
  mediaId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;
  if (!env.STORAGE) {
    return jsonError(500, 'server_misconfigured', 'Private media storage is not configured.', requestId);
  }
  const token = request.headers.get(UPLOAD_TOKEN_HEADER);
  if (!token) return jsonError(401, 'upload_token_required', 'A scoped upload token is required.', requestId);

  const row = await loadMediaRow(env.DB, workspaceId, mediaId);
  if (!row || row.uploader_user_id !== scope.user.id) {
    return jsonError(404, 'media_not_found', 'Upload claim not found.', requestId);
  }
  if (row.state === 'validated' || row.state === 'transcribing' || row.state === 'ready') {
    const alreadyUploaded =
      row.format === 'image/jpeg' || row.format === 'image/png' || row.format === 'image/webp'
        ? 'This image was already uploaded.'
        : 'This recording was already uploaded.';
    return jsonError(409, 'upload_already_finalized', alreadyUploaded, requestId);
  }
  if (row.state !== 'quarantine') {
    return jsonError(410, 'upload_closed', 'This upload claim is no longer usable.', requestId);
  }
  const nowIso = new Date().toISOString();
  if (!row.upload_token_expires_at || row.upload_token_expires_at <= nowIso) {
    const expiredMessage =
      row.format === 'image/jpeg' || row.format === 'image/png' || row.format === 'image/webp'
        ? 'The upload ticket expired. Start a new upload.'
        : 'The upload ticket expired. Start a new recording.';
    return jsonError(409, 'upload_token_expired', expiredMessage, requestId);
  }
  const tokenHash = await hashUploadToken(token);
  if (tokenHash !== row.upload_token_hash) {
    const invalidMessage =
      row.format === 'image/jpeg' || row.format === 'image/png' || row.format === 'image/webp'
        ? 'The upload ticket is not valid for this image.'
        : 'The upload ticket is not valid for this recording.';
    return jsonError(403, 'upload_token_invalid', invalidMessage, requestId);
  }

  const isImageClaim = row.format === 'image/jpeg' || row.format === 'image/png' || row.format === 'image/webp';
  if (isImageClaim) {
    const bounded = await readBoundedBody(request, IMAGE_BOUNDS.MAX_BYTES);
    if (!bounded.ok) {
      if (bounded.code === 'too_large') {
        return jsonError(413, 'payload_too_large', `Images must be at most ${IMAGE_BOUNDS.MAX_BYTES} bytes.`, requestId);
      }
      return jsonError(400, 'upload_read_failed', 'The image body could not be read.', requestId);
    }
    const bytes = bounded.bytes;
    if (bytes.byteLength < IMAGE_BOUNDS.MIN_BYTES) {
      return jsonError(422, 'invalid_image', 'The image is too small to be usable.', requestId);
    }
    const inspection = inspectImageBytes(bytes);
    if (!inspection.format || inspection.format !== row.format) {
      await env.STORAGE.delete(row.object_key).catch(() => undefined);
      await rejectMedia(env.DB, {
        workspaceId,
        mediaId,
        code: 'container_mismatch',
        message: `The image bytes are not a valid ${row.format ?? 'supported'} container.`,
        nowIso,
      });
      return jsonError(422, 'invalid_image', 'The image bytes do not match a supported image container.', requestId);
    }
    await env.STORAGE.put(row.object_key, bytes, {
      httpMetadata: { contentType: row.content_type ?? 'application/octet-stream' },
    });
    const recorded = await markUploadBytesReceived(env.DB, {
      workspaceId,
      mediaId,
      uploaderUserId: scope.user.id,
      tokenHash,
      byteSize: bytes.byteLength,
      durationMs: 0,
      nowIso,
    });
    if (!recorded) {
      await env.STORAGE.delete(row.object_key).catch(() => undefined);
      return jsonError(409, 'upload_conflict', 'The upload claim changed while bytes were received.', requestId);
    }
    const media = await loadSummary(env, workspaceId, mediaId);
    const imageResponseBody: VoiceMediaStatusResponse = { status: 'ok', media: media! };
    return jsonSuccess(imageResponseBody, 200, { 'x-request-id': requestId });
  }

  const bounded = await readBoundedBody(request, VOICE_BOUNDS.MAX_BYTES);
  if (!bounded.ok) {
    if (bounded.code === 'too_large') {
      return jsonError(413, 'payload_too_large', `Recordings must be at most ${VOICE_BOUNDS.MAX_BYTES} bytes.`, requestId);
    }
    return jsonError(400, 'upload_read_failed', 'The recording body could not be read.', requestId);
  }
  const bytes = bounded.bytes;
  if (bytes.byteLength < VOICE_BOUNDS.MIN_BYTES) {
    return jsonError(422, 'invalid_audio', 'The recording is too small to be usable.', requestId);
  }

  const inspection = inspectAudioBytes(bytes);
  if (!inspection.format || inspection.format !== row.format) {
    await env.STORAGE.delete(row.object_key).catch(() => undefined);
    await rejectMedia(env.DB, {
      workspaceId,
      mediaId,
      code: 'container_mismatch',
      message: `The recording bytes are not a valid ${row.format ?? 'supported'} container.`,
      nowIso,
    });
    return jsonError(422, 'invalid_audio', 'The recording bytes do not match a supported audio container.', requestId);
  }

  // Actual duration is mandatory: a client-declared duration is never trusted
  // as proof that a recording fits the three-minute product cap.
  if (inspection.durationMs === null) {
    await env.STORAGE.delete(row.object_key).catch(() => undefined);
    await rejectMedia(env.DB, {
      workspaceId,
      mediaId,
      code: 'duration_unverified',
      message: 'The recording duration could not be verified from its container.',
      nowIso,
    });
    return jsonError(422, 'duration_unverified', 'The recording duration could not be verified.', requestId);
  }
  if (inspection.durationMs > VOICE_BOUNDS.MAX_DURATION_SECONDS * 1000 + 500) {
    await env.STORAGE.delete(row.object_key).catch(() => undefined);
    await rejectMedia(env.DB, {
      workspaceId,
      mediaId,
      code: 'duration_limit',
      message: `Recordings must be at most ${VOICE_BOUNDS.MAX_DURATION_SECONDS} seconds.`,
      nowIso,
    });
    return jsonError(422, 'duration_limit', `Recordings must be at most ${VOICE_BOUNDS.MAX_DURATION_SECONDS} seconds.`, requestId);
  }

  await env.STORAGE.put(row.object_key, bytes, {
    httpMetadata: { contentType: row.content_type ?? 'application/octet-stream' },
  });
  const recorded = await markUploadBytesReceived(env.DB, {
    workspaceId,
    mediaId,
    uploaderUserId: scope.user.id,
    tokenHash,
    byteSize: bytes.byteLength,
    durationMs: inspection.durationMs,
    nowIso,
  });
  if (!recorded) {
    await env.STORAGE.delete(row.object_key).catch(() => undefined);
    return jsonError(409, 'upload_conflict', 'The upload claim changed while bytes were received.', requestId);
  }

  const media = await loadSummary(env, workspaceId, mediaId);
  const responseBody: VoiceMediaStatusResponse = { status: 'ok', media: media! };
  return jsonSuccess(responseBody, 200, { 'x-request-id': requestId });
}

/**
 * POST /api/workspaces/:workspaceId/media/uploads/:mediaId/finalize
 * Validates the quarantined object and re-checks the route before accepting.
 */
export async function handleFinalizeVoiceUpload(
  request: Request,
  env: Env,
  workspaceId: string,
  mediaId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;
  if (!env.STORAGE) {
    return jsonError(500, 'server_misconfigured', 'Private media storage is not configured.', requestId);
  }
  const row = await loadMediaRow(env.DB, workspaceId, mediaId);
  if (!row || row.uploader_user_id !== scope.user.id) {
    return jsonError(404, 'media_not_found', 'Upload claim not found.', requestId);
  }
  const nowIso = new Date().toISOString();
  if (row.state === 'validated' || row.state === 'transcribing' || row.state === 'ready') {
    const media = await loadSummary(env, workspaceId, mediaId);
    const responseBody: FinalizeVoiceUploadResponse = { status: 'ok', media: media! };
    return jsonSuccess(responseBody, 200, { 'x-request-id': requestId });
  }
  if (row.state !== 'quarantine' || !row.upload_completed_at) {
    return jsonError(409, 'media_not_ready', 'The recording bytes were not received.', requestId);
  }
  if ((row.retained !== 1 && row.expires_at <= nowIso)) {
    await markMediaExpired(env.DB, { workspaceId, mediaId, nowIso });
    return jsonError(410, 'audio_expired', 'This recording expired before it was sent.', requestId);
  }
  const isImageRow = row.format === 'image/jpeg' || row.format === 'image/png' || row.format === 'image/webp';
  if (isImageRow) {
    if ((row.byte_size ?? 0) < IMAGE_BOUNDS.MIN_BYTES || (row.byte_size ?? 0) > IMAGE_BOUNDS.MAX_BYTES) {
      await env.STORAGE.delete(row.object_key).catch(() => undefined);
      await rejectMedia(env.DB, { workspaceId, mediaId, code: 'byte_limit', message: 'Image size is outside the allowed bounds.', nowIso });
      return jsonError(422, 'byte_limit', 'Image size is outside the allowed bounds.', requestId);
    }
    const finalized = await finalizeMediaValidation(env.DB, {
      workspaceId,
      mediaId,
      uploaderUserId: scope.user.id,
      durationMs: 0,
      nowIso,
    });
    if (!finalized) {
      return jsonError(409, 'finalize_conflict', 'The upload state changed before finalization.', requestId);
    }
    const media = await loadSummary(env, workspaceId, mediaId);
    const imageResponseBody: FinalizeVoiceUploadResponse = { status: 'ok', media: media! };
    return jsonSuccess(imageResponseBody, 200, { 'x-request-id': requestId });
  }
  if ((row.byte_size ?? 0) < VOICE_BOUNDS.MIN_BYTES || (row.byte_size ?? 0) > VOICE_BOUNDS.MAX_BYTES) {
    await env.STORAGE.delete(row.object_key).catch(() => undefined);
    await rejectMedia(env.DB, { workspaceId, mediaId, code: 'byte_limit', message: 'Recording size is outside the allowed bounds.', nowIso });
    return jsonError(422, 'byte_limit', 'Recording size is outside the allowed bounds.', requestId);
  }

  // Re-check availability at finalize: configuration may have changed since
  // the claim. A verification sample is allowed to finalize so it can be
  // consumed by the server-side verify route; it can never become a message.
  const availability = await voiceUploadAvailability(
    env,
    workspaceId,
    row.chat_id ?? '',
    scope.user.id,
    row.format ?? row.content_type ?? '',
  );
  if (availability.route.route === 'unavailable' && !availability.verificationSample) {
    await env.STORAGE.delete(row.object_key).catch(() => undefined);
    await rejectMedia(env.DB, { workspaceId, mediaId, code: 'voice_unavailable', message: availability.route.message, nowIso });
    return jsonError(422, 'voice_unavailable', availability.route.message, requestId);
  }

  const finalized = await finalizeMediaValidation(env.DB, {
    workspaceId,
    mediaId,
    uploaderUserId: scope.user.id,
    durationMs: row.duration_ms ?? 0,
    nowIso,
  });
  if (!finalized) {
    return jsonError(409, 'finalize_conflict', 'The upload state changed before finalization.', requestId);
  }
  const media = await loadSummary(env, workspaceId, mediaId);
  const responseBody: FinalizeVoiceUploadResponse = { status: 'ok', media: media! };
  return jsonSuccess(responseBody, 200, { 'x-request-id': requestId });
}

/**
 * POST /api/workspaces/:workspaceId/voice/verify/:mediaId
 *
 * One bounded server-side format verification: the server actually
 * transcribes a validated sample of the actual container with the workspace
 * key and records the evidence itself. A client-declared format list can
 * never grant capability. The sample is deleted and never becomes a message.
 */
export async function handleVerifyVoiceFormat(
  request: Request,
  env: Env,
  workspaceId: string,
  mediaId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;
  if (!env.STORAGE) {
    return jsonError(500, 'server_misconfigured', 'Private media storage is not configured.', requestId);
  }
  const row = await loadMediaRow(env.DB, workspaceId, mediaId);
  if (!row || row.uploader_user_id !== scope.user.id) {
    return jsonError(404, 'media_not_found', 'Verification sample not found.', requestId);
  }
  const nowIso = new Date().toISOString();
  if ((row.retained !== 1 && row.expires_at <= nowIso)) {
    await markMediaExpired(env.DB, { workspaceId, mediaId, nowIso });
    return jsonError(410, 'audio_expired', 'This verification sample expired.', requestId);
  }
  if (row.state !== 'validated' || !row.format) {
    return jsonError(409, 'media_not_validated', 'The verification sample is not ready.', requestId);
  }
  const stored = await getWorkspaceVoiceSettings(env.DB, workspaceId);
  if (!stored.enabled || !stored.model) {
    return jsonError(422, 'voice_not_configured', 'Enable voice and choose an STT model before verifying a format.', requestId);
  }
  const platformKeys = extractPlatformKeys(env);
  const credential = await getCredentialMetadata(env.DB, { workspaceId, provider: 'groq' });
  let rawKey: string | null = null;
  if (credential?.status === 'available') {
    if (!env.CREDENTIALS_KEY) {
      return jsonError(500, 'server_misconfigured', 'Credential storage is not configured.', requestId);
    }
    let wrappingKey: CryptoKey;
    try {
      wrappingKey = await importWrappingKey(env.CREDENTIALS_KEY);
      rawKey = (
        await decryptWorkspaceCredential(env.DB, { workspaceId, provider: 'groq', wrappingKey })
      ).rawKey;
    } catch {
      return jsonError(422, 'stt_credential_unreadable', 'The Groq transcription key could not be used.', requestId);
    }
  } else if (platformKeys.groq) {
    rawKey = platformKeys.groq;
  } else {
    return jsonError(422, 'stt_credential_unavailable', 'Groq transcription credential is not available.', requestId);
  }

  const object = await env.STORAGE.get(row.object_key);
  if (!object) {
    return jsonError(410, 'audio_unavailable', 'The verification sample bytes are no longer available.', requestId);
  }
  const bytes = new Uint8Array(await object.arrayBuffer());

  const model = GROQ_STT_MODELS.find((candidate) => candidate === stored.model)!;
  const extension = row.format === 'audio/ogg' ? 'ogg' : row.format === 'audio/mp4' ? 'm4a' : 'webm';
  const result = await transcribeWithGroq({
    apiKey: rawKey,
    model,
    bytes,
    filename: `verify-${mediaId}.${extension}`,
    mimeType: row.format,
    fetchFn: sttFetch(env),
  });
  if (!result.ok) {
    if (result.code === 'invalid_request') {
      await env.STORAGE.delete(row.object_key).catch(() => undefined);
      await rejectMedia(env.DB, {
        workspaceId,
        mediaId,
        code: 'unsupported_format',
        message: 'Groq rejected this container.',
        nowIso,
      });
      return jsonError(422, 'unsupported_format', 'The transcription provider rejected this container.', requestId);
    }
    if (result.code === 'invalid_credential') {
      return jsonError(422, 'stt_credential_invalid', result.message, requestId);
    }
    if (result.code === 'rate_limited') {
      return jsonError(429, 'rate_limited', result.message, requestId, true);
    }
    return jsonError(502, 'transcription_failed', result.message, requestId, result.retryable);
  }
  const transcript = result.text.trim();
  if (!transcript) {
    await env.STORAGE.delete(row.object_key).catch(() => undefined);
    await rejectMedia(env.DB, {
      workspaceId,
      mediaId,
      code: 'empty_transcript',
      message: 'No speech was detected in the verification sample.',
      nowIso,
    });
    return jsonError(422, 'empty_transcript', 'No speech was detected in the verification sample.', requestId);
  }

  const format = row.format;
  if (format !== 'audio/webm' && format !== 'audio/mp4' && format !== 'audio/ogg') {
    return jsonError(409, 'media_not_validated', 'The verification sample is not ready.', requestId);
  }
  const next = await recordVoiceFormatEvidence(env.DB, {
    workspaceId,
    actorUserId: scope.user.id,
    format,
    model: stored.model,
  });
  await env.STORAGE.delete(row.object_key).catch(() => undefined);
  await markMediaDeleted(env.DB, { workspaceId, mediaId, nowIso });

  const responseBody: VerifyVoiceFormatResponse = {
    status: 'ok',
    verified_format: format,
    verified_formats: next.verified_formats,
    transcription_verified: next.verified_formats.length === 3,
    model: stored.model,
    sample_deleted: true,
  };
  return jsonSuccess(responseBody, 200, { 'x-request-id': requestId });
}

/**
 * GET /api/workspaces/:workspaceId/media/:mediaId/status
 */
export async function handleGetVoiceMediaStatus(
  request: Request,
  env: Env,
  workspaceId: string,
  mediaId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;
  const row = await loadMediaRow(env.DB, workspaceId, mediaId);
  if (!row) return jsonError(404, 'media_not_found', 'Recording not found.', requestId);
  const nowIso = new Date().toISOString();
  if (
    (row.retained !== 1 && row.expires_at <= nowIso) &&
    (row.state === 'validated' || row.state === 'transcribing' || row.state === 'ready')
  ) {
    await markMediaExpired(env.DB, { workspaceId, mediaId, nowIso });
  }
  const media = await loadSummary(env, workspaceId, mediaId);
  const responseBody: VoiceMediaStatusResponse = { status: 'ok', media: media! };
  return jsonSuccess(responseBody, 200, { 'x-request-id': requestId });
}

function parseRange(header: string | null, size: number): { offset: number; length: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const startRaw = match[1] ?? '';
  const endRaw = match[2] ?? '';
  if (!startRaw && !endRaw) return null;
  let offset: number;
  let end: number;
  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    offset = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    offset = Number(startRaw);
    end = endRaw ? Number(endRaw) : size - 1;
  }
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || end < offset || offset >= size) {
    return null;
  }
  return { offset, length: Math.min(end, size - 1) - offset + 1 };
}

/**
 * GET /api/workspaces/:workspaceId/media/:mediaId
 * Authenticated private streaming/range read; teammates may read retained
 * audio, removed members cannot. Quarantine objects are inaccessible.
 */
export async function handleGetVoiceMediaContent(
  request: Request,
  env: Env,
  workspaceId: string,
  mediaId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;
  if (!env.STORAGE) {
    return jsonError(500, 'server_misconfigured', 'Private media storage is not configured.', requestId);
  }
  const row = await loadMediaRow(env.DB, workspaceId, mediaId);
  if (!row) return jsonError(404, 'media_not_found', 'Recording not found.', requestId);
  const nowIso = new Date().toISOString();
  if (row.state === 'quarantine') {
    // Quarantine stays inaccessible until validation succeeds.
    return jsonError(404, 'media_not_found', 'Recording not found.', requestId);
  }
  if (row.state === 'rejected' || row.state === 'deleted') {
    return jsonError(410, 'audio_unavailable', 'This recording is no longer available.', requestId);
  }
  if (row.state === 'expired' || (row.retained !== 1 && row.expires_at <= nowIso)) {
    if (row.state !== 'expired') await markMediaExpired(env.DB, { workspaceId, mediaId, nowIso });
    return jsonError(410, 'audio_expired', 'The recording expired. Its transcript remains readable.', requestId);
  }

  const rangeHeader = request.headers.get('range');
  if (!rangeHeader) {
    // Ordinary full read: one GET carries bytes and size together, so the
    // metadata head roundtrip is skipped. A missing object still 410s here.
    const object = await env.STORAGE.get(row.object_key);
    if (!object) {
      return jsonError(410, 'audio_unavailable', 'The recording object is no longer available.', requestId);
    }
    const headers = new Headers({
      'Content-Type': row.content_type ?? 'application/octet-stream',
      'Content-Length': String(object.size),
      'Accept-Ranges': 'bytes',
      // Private audio is never cached by browsers or the service worker.
      'Cache-Control': 'private, no-store',
      'x-request-id': requestId,
    });
    return new Response(object.body, { status: 200, headers });
  }
  const head = await env.STORAGE.head(row.object_key);
  if (!head) {
    return jsonError(410, 'audio_unavailable', 'The recording object is no longer available.', requestId);
  }
  // Ranged reads keep the head: total size drives range parsing, the 416
  // response, and Content-Range, and a ranged GET does not report it.
  const range = parseRange(rangeHeader, head.size);
  if (rangeHeader && !range) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${head.size}`, 'Cache-Control': 'private, no-store', 'x-request-id': requestId },
    });
  }
  const object = await env.STORAGE.get(row.object_key, range ? { range } : undefined);
  if (!object) {
    return jsonError(410, 'audio_unavailable', 'The recording object is no longer available.', requestId);
  }
  const headers = new Headers({
    'Content-Type': row.content_type ?? 'application/octet-stream',
    'Content-Length': String(range ? range.length : head.size),
    'Accept-Ranges': 'bytes',
    // Private audio is never cached by browsers or the service worker.
    'Cache-Control': 'private, no-store',
    'x-request-id': requestId,
  });
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Single dispatcher the integration coordinator can mount once. Returns null
 * when the path does not belong to the voice media surface.
 */
export async function handleVoiceMediaRoute(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const uploadCollection = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/media\/uploads$/);
  if (uploadCollection) {
    if (request.method === 'POST') {
      return handleCreateVoiceUpload(request, env, uploadCollection[1]!, requestId);
    }
    return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
  }
  const uploadContent = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/media\/uploads\/([^/]+)\/content$/);
  if (uploadContent) {
    if (request.method === 'PUT') {
      return handlePutVoiceUploadContent(request, env, uploadContent[1]!, uploadContent[2]!, requestId);
    }
    return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
  }
  const uploadFinalize = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/media\/uploads\/([^/]+)\/finalize$/);
  if (uploadFinalize) {
    if (request.method === 'POST') {
      return handleFinalizeVoiceUpload(request, env, uploadFinalize[1]!, uploadFinalize[2]!, requestId);
    }
    return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
  }
  const mediaStatus = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/media\/([^/]+)\/status$/);
  if (mediaStatus) {
    if (request.method === 'GET') {
      return handleGetVoiceMediaStatus(request, env, mediaStatus[1]!, mediaStatus[2]!, requestId);
    }
    return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
  }
  const mediaContent = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/media\/([^/]+)$/);
  if (mediaContent) {
    if (request.method === 'GET') {
      return handleGetVoiceMediaContent(request, env, mediaContent[1]!, mediaContent[2]!, requestId);
    }
    return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
  }
  const voiceVerify = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/voice\/verify\/([^/]+)$/);
  if (voiceVerify) {
    if (request.method === 'POST') {
      return handleVerifyVoiceFormat(request, env, voiceVerify[1]!, voiceVerify[2]!, requestId);
    }
    return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
  }
  const voiceSettings = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/voice\/settings$/);
  if (voiceSettings) {
    if (request.method === 'GET') {
      return handleGetVoiceSettings(request, env, voiceSettings[1]!, requestId);
    }
    if (request.method === 'PUT') {
      return handleUpdateVoiceSettings(request, env, voiceSettings[1]!, requestId);
    }
    return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
  }
  return null;
}

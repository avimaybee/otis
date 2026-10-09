/**
 * @otis/worker/media/repository
 * D1 persistence for private media objects and the durable transcription
 * receipt. Bytes stay in R2; these helpers never log or return them.
 */

import type {
  MediaFormat,
  VoiceFormat,
  VoiceMediaState,
  VoiceMediaSummary,
  VoiceTranscriptionSummary,
} from '@otis/contracts';
import { VOICE_BOUNDS } from '@otis/contracts';

export interface MediaRow {
  retained: number;
  deletion_claimed_at: string | null;
  filename: string | null;
  id: string;
  workspace_id: string;
  chat_id: string | null;
  uploader_user_id: string;
  client_message_id: string | null;
  state: VoiceMediaState;
  object_key: string;
  content_type: string | null;
  format: MediaFormat | null;
  byte_size: number | null;
  duration_ms: number | null;
  upload_token_hash: string | null;
  upload_token_expires_at: string | null;
  upload_completed_at: string | null;
  validated_at: string | null;
  expires_at: string;
  rejection_code: string | null;
  rejection_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface TranscriptionRow {
  id: string;
  media_id: string;
  workspace_id: string;
  message_in_id: string | null;
  run_id: string | null;
  state: 'pending' | 'running' | 'ready' | 'failed' | 'cancelled';
  route: 'native' | 'groq_stt';
  provider: string | null;
  model: string | null;
  format: VoiceFormat;
  language_hint: string | null;
  transcript_text: string | null;
  transcript_language: string | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  max_attempts: number;
  claim_owner: string | null;
  claim_expires_at: string | null;
  next_attempt_at: string | null;
  committed_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function hashUploadToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function toMediaSummary(
  row: Record<string, unknown>,
  transcription: TranscriptionRow | null,
): VoiceMediaSummary {
  const transcriptionSummary: VoiceTranscriptionSummary | null = transcription
    ? {
        state: transcription.state,
        route: transcription.route,
        provider: transcription.provider === 'groq' ? 'groq' : null,
        model: transcription.model,
        language: transcription.transcript_language,
        error_code: transcription.error_code,
        error_message: transcription.error_message,
      }
    : null;
  return {
    media_id: String(row['id']),
    workspace_id: String(row['workspace_id']),
    chat_id: row['chat_id'] ? String(row['chat_id']) : null,
    uploader_user_id: String(row['uploader_user_id']),
    state: String(row['state']) as VoiceMediaState,
    format: row['format'] ? (String(row['format']) as MediaFormat) : null,
    content_type: row['content_type'] ? String(row['content_type']) : null,
    byte_size: row['byte_size'] !== null && row['byte_size'] !== undefined ? Number(row['byte_size']) : null,
    duration_ms: row['duration_ms'] !== null && row['duration_ms'] !== undefined ? Number(row['duration_ms']) : null,
    created_at: String(row['created_at']),
    expires_at: String(row['expires_at']),
    transcript: transcription?.state === 'ready' ? transcription.transcript_text : null,
    transcription: transcriptionSummary,
  };
}

export async function loadMediaRow(
  db: D1Database,
  workspaceId: string,
  mediaId: string,
): Promise<MediaRow | null> {
  const row = await db
    .prepare(`SELECT * FROM media_objects WHERE id = ? AND workspace_id = ?`)
    .bind(mediaId, workspaceId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: String(row['id']),
    retained: Number(row['retained'] ?? 0),
    deletion_claimed_at: row['deletion_claimed_at'] == null ? null : String(row['deletion_claimed_at']),
    filename: row['filename'] == null ? null : String(row['filename']),
    workspace_id: String(row['workspace_id']),
    chat_id: row['chat_id'] ? String(row['chat_id']) : null,
    uploader_user_id: String(row['uploader_user_id']),
    client_message_id: row['client_message_id'] ? String(row['client_message_id']) : null,
    state: String(row['state']) as VoiceMediaState,
    object_key: String(row['object_key']),
    content_type: row['content_type'] ? String(row['content_type']) : null,
    format: row['format'] ? (String(row['format']) as MediaFormat) : null,
    byte_size: row['byte_size'] !== null && row['byte_size'] !== undefined ? Number(row['byte_size']) : null,
    duration_ms: row['duration_ms'] !== null && row['duration_ms'] !== undefined ? Number(row['duration_ms']) : null,
    upload_token_hash: row['upload_token_hash'] ? String(row['upload_token_hash']) : null,
    upload_token_expires_at: row['upload_token_expires_at'] ? String(row['upload_token_expires_at']) : null,
    upload_completed_at: row['upload_completed_at'] ? String(row['upload_completed_at']) : null,
    validated_at: row['validated_at'] ? String(row['validated_at']) : null,
    expires_at: String(row['expires_at']),
    rejection_code: row['rejection_code'] ? String(row['rejection_code']) : null,
    rejection_message: row['rejection_message'] ? String(row['rejection_message']) : null,
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at']),
  };
}

/** The single media lifecycle bound to one stable client message UUID. */
export async function findMediaByClientIdentity(
  db: D1Database,
  params: { workspaceId: string; chatId: string; uploaderUserId: string; clientMessageId: string },
): Promise<MediaRow | null> {
  const row = await db
    .prepare(
      `SELECT id FROM media_objects
       WHERE workspace_id = ? AND chat_id = ? AND uploader_user_id = ? AND client_message_id = ?`,
    )
    .bind(params.workspaceId, params.chatId, params.uploaderUserId, params.clientMessageId)
    .first<{ id: string }>();
  if (!row) return null;
  return loadMediaRow(db, params.workspaceId, String(row.id));
}

/**
 * Rotates the scoped ticket on an existing quarantine row. The object key is
 * unchanged, so an upload retry overwrites one private object instead of
 * orphaning another.
 */
export async function rotateMediaUploadTicket(
  db: D1Database,
  params: {
    workspaceId: string;
    mediaId: string;
    uploaderUserId: string;
    tokenHash: string;
    tokenExpiresAt: string;
    format: MediaFormat;
    contentType: string;
    durationMs: number;
    nowIso: string;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE media_objects
       SET upload_token_hash = ?, upload_token_expires_at = ?, duration_ms = ?, byte_size = NULL,
           upload_completed_at = NULL, content_type = ?, format = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND uploader_user_id = ? AND state = 'quarantine'`,
    )
    .bind(
      params.tokenHash,
      params.tokenExpiresAt,
      params.durationMs,
      params.contentType,
      params.format,
      params.nowIso,
      params.mediaId,
      params.workspaceId,
      params.uploaderUserId,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/**
 * Resets a rejected/expired/deleted row to a fresh quarantine claim on the
 * same object key. No second media identity or R2 object is created.
 */
export async function resetMediaUploadForRetry(
  db: D1Database,
  params: {
    workspaceId: string;
    mediaId: string;
    uploaderUserId: string;
    tokenHash: string;
    tokenExpiresAt: string;
    format: MediaFormat;
    contentType: string;
    durationMs: number;
    nowIso: string;
  },
): Promise<boolean> {
  const expiresAt = new Date(
    new Date(params.nowIso).getTime() + 14 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = await db
    .prepare(
      `UPDATE media_objects
       SET state = 'quarantine', upload_token_hash = ?, upload_token_expires_at = ?, duration_ms = ?,
           byte_size = NULL, upload_completed_at = NULL, validated_at = NULL,
           rejection_code = NULL, rejection_message = NULL, expires_at = ?,
           content_type = ?, format = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND uploader_user_id = ?
         AND state IN ('rejected', 'expired', 'deleted')`,
    )
    .bind(
      params.tokenHash,
      params.tokenExpiresAt,
      params.durationMs,
      expiresAt,
      params.contentType,
      params.format,
      params.nowIso,
      params.mediaId,
      params.workspaceId,
      params.uploaderUserId,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function loadTranscriptionRow(
  db: D1Database,
  mediaId: string,
): Promise<TranscriptionRow | null> {
  const row = await db
    .prepare(`SELECT * FROM media_transcriptions WHERE media_id = ?`)
    .bind(mediaId)
    .first<Record<string, unknown>>();
  return row ? normalizeTranscriptionRow(row) : null;
}

export async function loadTranscriptionRowById(
  db: D1Database,
  jobId: string,
): Promise<TranscriptionRow | null> {
  const row = await db
    .prepare(`SELECT * FROM media_transcriptions WHERE id = ?`)
    .bind(jobId)
    .first<Record<string, unknown>>();
  return row ? normalizeTranscriptionRow(row) : null;
}

function normalizeTranscriptionRow(row: Record<string, unknown>): TranscriptionRow {
  return {
    id: String(row['id']),
    media_id: String(row['media_id']),
    workspace_id: String(row['workspace_id']),
    message_in_id: row['message_in_id'] ? String(row['message_in_id']) : null,
    run_id: row['run_id'] ? String(row['run_id']) : null,
    state: String(row['state']) as TranscriptionRow['state'],
    route: String(row['route']) as TranscriptionRow['route'],
    provider: row['provider'] ? String(row['provider']) : null,
    model: row['model'] ? String(row['model']) : null,
    format: String(row['format']) as VoiceFormat,
    language_hint: row['language_hint'] ? String(row['language_hint']) : null,
    transcript_text: row['transcript_text'] ? String(row['transcript_text']) : null,
    transcript_language: row['transcript_language'] ? String(row['transcript_language']) : null,
    error_code: row['error_code'] ? String(row['error_code']) : null,
    error_message: row['error_message'] ? String(row['error_message']) : null,
    attempt_count: Number(row['attempt_count']),
    max_attempts: Number(row['max_attempts']),
    claim_owner: row['claim_owner'] ? String(row['claim_owner']) : null,
    claim_expires_at: row['claim_expires_at'] ? String(row['claim_expires_at']) : null,
    next_attempt_at: row['next_attempt_at'] ? String(row['next_attempt_at']) : null,
    committed_at: row['committed_at'] ? String(row['committed_at']) : null,
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at']),
  };
}

export interface CreateMediaUploadParams {
  mediaId: string;
  workspaceId: string;
  chatId: string;
  uploaderUserId: string;
  clientMessageId: string;
  format: MediaFormat;
  contentType: string;
  byteSize: number;
  durationMs: number;
  objectKey: string;
  tokenHash: string;
  tokenExpiresAt: string;
  nowIso: string;
}

/**
 * Claims a bounded quarantine upload. Retention starts at creation (14 days).
 * Membership is guarded in the same batch so a removal between route check
 * and commit aborts the write.
 */
export async function createMediaUpload(db: D1Database, params: CreateMediaUploadParams): Promise<void> {
  const expiresAt = new Date(
    new Date(params.nowIso).getTime() + 14 * 24 * 60 * 60 * 1000,
  ).toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO lifecycle_guards (id, guard_ok)
         VALUES (?, (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?))`,
      )
      .bind(crypto.randomUUID(), params.workspaceId, params.uploaderUserId),
    db
      .prepare(
        `INSERT INTO media_objects
           (id, workspace_id, chat_id, uploader_user_id, client_message_id, state, object_key, content_type, format,
            byte_size, duration_ms, upload_token_hash, upload_token_expires_at, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'quarantine', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        params.mediaId,
        params.workspaceId,
        params.chatId,
        params.uploaderUserId,
        params.clientMessageId,
        params.objectKey,
        params.contentType,
        params.format,
        params.durationMs,
        params.tokenHash,
        params.tokenExpiresAt,
        expiresAt,
        params.nowIso,
        params.nowIso,
      ),
  ]);
}

/** Server-ingested channel media (Telegram) that was validated before storage. */
export async function createValidatedMedia(
  db: D1Database,
  params: {
    mediaId: string;
    workspaceId: string;
    chatId: string;
    uploaderUserId: string;
    format: MediaFormat;
    contentType: string;
    byteSize: number;
    durationMs: number;
    objectKey: string;
    nowIso: string;
  },
): Promise<void> {
  const expiresAt = new Date(
    new Date(params.nowIso).getTime() + 14 * 24 * 60 * 60 * 1000,
  ).toISOString();
  await db
    .prepare(
      `INSERT INTO media_objects
         (id, workspace_id, chat_id, uploader_user_id, state, object_key, content_type, format,
          byte_size, duration_ms, upload_completed_at, validated_at, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'validated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      params.mediaId,
      params.workspaceId,
      params.chatId,
      params.uploaderUserId,
      params.objectKey,
      params.contentType,
      params.format,
      params.byteSize,
      params.durationMs,
      params.nowIso,
      params.nowIso,
      expiresAt,
      params.nowIso,
      params.nowIso,
    )
    .run();
}

/** Records received bytes and the verified actual duration while quarantined. */
export async function markUploadBytesReceived(
  db: D1Database,
  params: {
    workspaceId: string;
    mediaId: string;
    uploaderUserId: string;
    tokenHash: string;
    byteSize: number;
    /** Actual duration parsed from the container; never a client-declared value. */
    durationMs: number;
    nowIso: string;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE media_objects
       SET byte_size = ?, duration_ms = ?, upload_completed_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND uploader_user_id = ? AND state = 'quarantine'
         AND upload_token_hash = ? AND upload_token_expires_at > ?`,
    )
    .bind(
      params.byteSize,
      params.durationMs,
      params.nowIso,
      params.nowIso,
      params.mediaId,
      params.workspaceId,
      params.uploaderUserId,
      params.tokenHash,
      params.nowIso,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/**
 * Finalizes a quarantined upload into `validated`. The token is consumed and
 * the actual duration replaces the declared value when the container parsed.
 */
export async function finalizeMediaValidation(
  db: D1Database,
  params: {
    workspaceId: string;
    mediaId: string;
    uploaderUserId: string;
    durationMs: number;
    nowIso: string;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE media_objects
       SET state = 'validated', duration_ms = ?, validated_at = ?, upload_token_hash = NULL,
           upload_token_expires_at = NULL, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND uploader_user_id = ? AND state = 'quarantine'
         AND upload_completed_at IS NOT NULL`,
    )
    .bind(
      params.durationMs,
      params.nowIso,
      params.nowIso,
      params.mediaId,
      params.workspaceId,
      params.uploaderUserId,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/** Rejects invalid quarantine bytes; the caller deletes the R2 object. */
export async function rejectMedia(
  db: D1Database,
  params: { workspaceId: string; mediaId: string; code: string; message: string; nowIso: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE media_objects
       SET state = 'rejected', rejection_code = ?, rejection_message = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND state IN ('quarantine', 'validated')`,
    )
    .bind(params.code, params.message, params.nowIso, params.mediaId, params.workspaceId)
    .run();
}

export interface CreateTranscriptionIntentParams {
  id: string;
  workspaceId: string;
  mediaId: string;
  messageInId: string;
  runId: string;
  route: 'native' | 'groq_stt';
  provider: string | null;
  model: string | null;
  format: VoiceFormat;
  languageHint: string | null;
  nowIso: string;
}

/**
 * Prepared statements for the acceptance batch. Keeping them as statements
 * lets message acceptance commit the media transition and the logical
 * transcription intent atomically with the run and outbox rows.
 */
export function transcriptionIntentStatement(
  db: D1Database,
  params: CreateTranscriptionIntentParams,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO media_transcriptions
         (id, workspace_id, media_id, message_in_id, run_id, state, route, provider, model, format,
          language_hint, attempt_count, max_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .bind(
      params.id,
      params.workspaceId,
      params.mediaId,
      params.messageInId,
      params.runId,
      params.route,
      params.provider,
      params.model,
      params.format,
      params.languageHint,
      VOICE_BOUNDS.MAX_TRANSCRIPTION_ATTEMPTS,
      params.nowIso,
      params.nowIso,
    );
}

/** Acceptance guard: the media must still be the caller's validated object. */
export function mediaValidatedGuardStatement(
  db: D1Database,
  params: { workspaceId: string; mediaId: string; uploaderUserId: string; nowIso: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO acceptance_guards (id, guard_ok)
       VALUES (?, (SELECT 1 FROM media_objects
         WHERE id = ? AND workspace_id = ? AND uploader_user_id = ? AND state = 'validated' AND expires_at > ?))`,
    )
    .bind(
      `guard_${crypto.randomUUID()}`,
      params.mediaId,
      params.workspaceId,
      params.uploaderUserId,
      params.nowIso,
    );
}

/**
 * Acceptance guard for one attached still image: at commit it must still be
 * the caller's validated, unexpired image object. The kind is rechecked
 * because a retried claim can rotate a row's container.
 */
export function imageAttachmentGuardStatement(
  db: D1Database,
  params: { workspaceId: string; mediaId: string; uploaderUserId: string; nowIso: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO acceptance_guards (id, guard_ok)
       VALUES (?, (SELECT 1 FROM media_objects
         WHERE id = ? AND workspace_id = ? AND uploader_user_id = ? AND state = 'validated'
           AND format IN ('image/jpeg', 'image/png', 'image/webp') AND expires_at > ?))`,
    )
    .bind(
      `guard_${crypto.randomUUID()}`,
      params.mediaId,
      params.workspaceId,
      params.uploaderUserId,
      params.nowIso,
    );
}

/**
 * Durable message→image receipt committed with acceptance: the link rows
 * are what the turn loader reads, so consumed media is always referenced.
 */
export function linkImageAttachmentStatement(
  db: D1Database,
  params: { chatMessageId: string; workspaceId: string; mediaId: string; position: number; nowIso: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO message_image_attachments (chat_message_id, media_id, workspace_id, position, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(params.chatMessageId, params.mediaId, params.workspaceId, params.position, params.nowIso);
}

/** Media transition committed with acceptance; guarded on the validated state. */
export function markMediaTranscribingStatement(
  db: D1Database,
  params: { workspaceId: string; mediaId: string; nowIso: string },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE media_objects SET state = 'transcribing', updated_at = ?
       WHERE id = ? AND workspace_id = ? AND state = 'validated'`,
    )
    .bind(params.nowIso, params.mediaId, params.workspaceId);
}

/**
 * Marks a media row transcribing when its intent commits. Guarded on the
 * validated state so a rejected/expired row cannot start inference.
 */
export async function markMediaTranscribing(
  db: D1Database,
  params: { workspaceId: string; mediaId: string; nowIso: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE media_objects SET state = 'transcribing', updated_at = ?
       WHERE id = ? AND workspace_id = ? AND state = 'validated'`,
    )
    .bind(params.nowIso, params.mediaId, params.workspaceId)
    .run();
}

export async function markMediaReady(
  db: D1Database,
  params: { workspaceId: string; mediaId: string; nowIso: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE media_objects SET state = 'ready', updated_at = ?
       WHERE id = ? AND workspace_id = ? AND state IN ('validated', 'transcribing')`,
    )
    .bind(params.nowIso, params.mediaId, params.workspaceId)
    .run();
}

export async function markMediaExpired(
  db: D1Database,
  params: { workspaceId: string; mediaId: string; nowIso: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE media_objects SET state = 'expired', updated_at = ?
       WHERE id = ? AND workspace_id = ? AND retained = 0 AND state IN ('validated', 'transcribing', 'ready', 'rejected')`,
    )
    .bind(params.nowIso, params.mediaId, params.workspaceId)
    .run();
}

export async function markMediaDeleted(
  db: D1Database,
  params: { workspaceId: string; mediaId: string; nowIso: string },
): Promise<void> {
  await db
    .prepare(`UPDATE media_objects SET state = 'deleted', updated_at = ? WHERE id = ? AND workspace_id = ?`)
    .bind(params.nowIso, params.mediaId, params.workspaceId)
    .run();
}

/** Expired objects due for R2 deletion; idempotent and bounded. */
export async function listExpiredMedia(
  db: D1Database,
  nowIso: string,
  limit = 25,
): Promise<Array<{ id: string; workspace_id: string; object_key: string }>> {
  const { results } = await db
    .prepare(
      `SELECT id, workspace_id, object_key FROM media_objects
       WHERE retained = 0 AND ((expires_at <= ? AND state IN ('validated', 'transcribing', 'ready', 'rejected')) OR (state = 'expired' AND deletion_claimed_at IS NOT NULL))
       ORDER BY expires_at ASC LIMIT ?`,
    )
    .bind(nowIso, limit)
    .all<{ id: string; workspace_id: string; object_key: string }>();
  return results ?? [];
}

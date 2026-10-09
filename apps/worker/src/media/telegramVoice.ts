/**
 * @otis/worker/media/telegramVoice
 * Telegram OGG/Opus voice ingest for Gate 010.
 *
 * Downloads one voice/audio attachment through the fixed Telegram Bot API
 * origin, validates the actual OGG container and duration, stores the bytes
 * in private R2, and commits the same durable acceptance shape as a text
 * message: source row, agent run, chat bubble, activity, dispatch intent and
 * one logical transcription receipt. No public URL and no key in logs.
 */

import { VOICE_BOUNDS, type VoiceFormat } from '@otis/contracts';
import { resolveModelForChat, resolveVoiceRouteForWorkspace, type PlatformKeys } from '../providers/service.js';
import { resolveThinkingSnapshot } from '../inbox/repository.js';
import { inspectAudioBytes, sniffAudioContainer } from './container.js';
import { createValidatedMedia, transcriptionIntentStatement } from './repository.js';

export type TelegramFileFetch = (url: string, init: RequestInit) => Promise<Response>;

const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';

export type TelegramVoiceErrorCode =
  | 'file_unavailable'
  | 'too_large'
  | 'invalid_audio'
  | 'duration_limit'
  | 'voice_unavailable'
  | 'transport_failed';

export class TelegramVoiceError extends Error {
  public readonly code: TelegramVoiceErrorCode;

  constructor(code: TelegramVoiceErrorCode, message: string) {
    super(message);
    this.name = 'TelegramVoiceError';
    this.code = code;
  }
}

export interface TelegramVoiceMetadata {
  fileId: string;
  durationSeconds: number;
  mimeType: string | null;
}

/** Extracts file identity from a normalized Telegram voice/audio message. */
export function extractTelegramVoiceMetadata(rawUpdate: unknown): TelegramVoiceMetadata | null {
  if (!rawUpdate || typeof rawUpdate !== 'object') return null;
  const message = (rawUpdate as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  const voice = record['voice'] as Record<string, unknown> | undefined;
  const audio = record['audio'] as Record<string, unknown> | undefined;
  const source = voice ?? audio;
  if (!source || typeof source.file_id !== 'string' || !source.file_id) return null;
  const duration = typeof source.duration === 'number' && Number.isFinite(source.duration) ? source.duration : 0;
  const mimeType = typeof source.mime_type === 'string' && source.mime_type ? source.mime_type : null;
  return { fileId: source.file_id, durationSeconds: duration, mimeType };
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export interface TelegramVoiceAcceptParams {
  db: D1Database;
  storage: R2Bucket;
  workspaceId: string;
  userId: string;
  chatId: string;
  botToken: string;
  externalId: string;
  fingerprint: string;
  persistedPayload: string;
  telegramMessageId: string;
  metadata: TelegramVoiceMetadata;
  nowIso: string;
  fetchFn?: TelegramFileFetch;
  platformKeys?: PlatformKeys;
}

export interface TelegramVoiceAcceptResult {
  messageInId: string;
  chatMessageId: string;
  runId: string;
  mediaId: string;
}

/**
 * Downloads, validates and durably accepts one Telegram voice note. Throws a
 * typed TelegramVoiceError before any D1 write when the media or route is not
 * usable; callers persist the honest unsupported state themselves.
 */
export async function acceptTelegramVoiceMessage(
  params: TelegramVoiceAcceptParams,
): Promise<TelegramVoiceAcceptResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const declaredSeconds = params.metadata.durationSeconds;
  if (declaredSeconds > VOICE_BOUNDS.MAX_DURATION_SECONDS) {
    throw new TelegramVoiceError(
      'duration_limit',
      `Voice notes must be at most ${VOICE_BOUNDS.MAX_DURATION_SECONDS} seconds.`,
    );
  }

  // 1. Resolve the file path through the fixed Bot API endpoint.
  let filePath: string;
  try {
    const getFileResponse = await fetchFn(`${TELEGRAM_API_ORIGIN}/bot${params.botToken}/getFile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: params.metadata.fileId }),
    });
    if (!getFileResponse.ok) {
      throw new TelegramVoiceError('file_unavailable', 'Telegram did not return this voice file.');
    }
    const body = (await getFileResponse.json()) as { ok?: boolean; result?: { file_path?: unknown; file_size?: unknown } };
    const path = body?.ok && typeof body.result?.file_path === 'string' ? body.result.file_path : null;
    if (!path || path.includes('..') || path.startsWith('/')) {
      throw new TelegramVoiceError('file_unavailable', 'Telegram did not return a usable voice file path.');
    }
    const declaredSize = typeof body.result?.file_size === 'number' ? body.result.file_size : null;
    if (declaredSize !== null && declaredSize > VOICE_BOUNDS.MAX_BYTES) {
      throw new TelegramVoiceError('too_large', `Voice notes must be at most ${VOICE_BOUNDS.MAX_BYTES} bytes.`);
    }
    filePath = path;
  } catch (err) {
    if (err instanceof TelegramVoiceError) throw err;
    throw new TelegramVoiceError('transport_failed', 'Telegram voice download could not be started.');
  }

  // 2. Download bounded bytes and validate the actual container.
  let bytes: Uint8Array;
  try {
    const fileResponse = await fetchFn(`${TELEGRAM_API_ORIGIN}/file/bot${params.botToken}/${filePath}`, {
      method: 'GET',
    });
    if (!fileResponse.ok) {
      throw new TelegramVoiceError('file_unavailable', 'Telegram did not return this voice file.');
    }
    const body = await readBounded(fileResponse, VOICE_BOUNDS.MAX_BYTES);
    if (!body) throw new TelegramVoiceError('too_large', `Voice notes must be at most ${VOICE_BOUNDS.MAX_BYTES} bytes.`);
    bytes = body;
  } catch (err) {
    if (err instanceof TelegramVoiceError) throw err;
    throw new TelegramVoiceError('transport_failed', 'Telegram voice download failed.');
  }
  if (bytes.byteLength < VOICE_BOUNDS.MIN_BYTES) {
    throw new TelegramVoiceError('invalid_audio', 'The voice note is too small to be usable.');
  }
  const format = sniffAudioContainer(bytes);
  if (format !== 'audio/ogg') {
    throw new TelegramVoiceError('invalid_audio', 'Telegram voice notes must be OGG/Opus audio.');
  }
  const inspection = inspectAudioBytes(bytes);
  if (inspection.durationMs === null) {
    throw new TelegramVoiceError('invalid_audio', 'The voice note duration could not be verified from its container.');
  }
  if (inspection.durationMs > VOICE_BOUNDS.MAX_DURATION_SECONDS * 1000 + 500) {
    throw new TelegramVoiceError(
      'duration_limit',
      `Voice notes must be at most ${VOICE_BOUNDS.MAX_DURATION_SECONDS} seconds.`,
    );
  }

  // 3. Resolve the same snapshot route used by web acceptance.
  const model = await resolveModelForChat(params.db, {
    workspaceId: params.workspaceId,
    actorUserId: params.userId,
    chatId: params.chatId,
  });
  const route = await resolveVoiceRouteForWorkspace(params.db, {
    workspaceId: params.workspaceId,
    model: model.available ? model.entry : null,
    audioMimeOrExt: 'audio/ogg',
    platformKeys: params.platformKeys,
  });
  if (route.route === 'unavailable') {
    throw new TelegramVoiceError('voice_unavailable', route.message);
  }

  // 4. Store validated bytes privately, then commit durable acceptance.
  const mediaId = `med_${crypto.randomUUID()}`;
  const objectKey = `workspace/${params.workspaceId}/media/${mediaId}`;
  await params.storage.put(objectKey, bytes, { httpMetadata: { contentType: 'audio/ogg' } });
  await createValidatedMedia(params.db, {
    mediaId,
    workspaceId: params.workspaceId,
    chatId: params.chatId,
    uploaderUserId: params.userId,
    format: 'audio/ogg' as VoiceFormat,
    contentType: 'audio/ogg',
    byteSize: bytes.byteLength,
    durationMs: inspection.durationMs,
    objectKey,
    nowIso: params.nowIso,
  });

  const messageInId = `min_${crypto.randomUUID()}`;
  const chatMessageId = `msg_${crypto.randomUUID()}`;
  const runId = `run_${crypto.randomUUID()}`;
  const outboxId = `out_${crypto.randomUUID()}`;
  const activityId = `act_${crypto.randomUUID()}`;
  const { thinkingSnapshotJson } = await resolveThinkingSnapshot(params.db, {
    workspaceId: params.workspaceId,
    chatId: params.chatId,
  });
  const seqRow = await params.db
    .prepare(`SELECT COALESCE(MAX(sequence), 0) as max_seq FROM chat_messages WHERE chat_id = ?`)
    .bind(params.chatId)
    .first<{ max_seq: number }>();
  const nextSeq = (seqRow?.max_seq || 0) + 1;

  await params.db.batch([
    params.db
      .prepare(
        `INSERT INTO acceptance_guards (id, guard_ok)
         VALUES (?, (SELECT 1 FROM workspace_users wu
           JOIN chats c ON c.id = ? AND c.workspace_id = wu.workspace_id AND c.author_user_id = wu.user_id
           WHERE wu.workspace_id = ? AND wu.user_id = ?))`,
      )
      .bind(`guard_${crypto.randomUUID()}`, params.chatId, params.workspaceId, params.userId),
    params.db
      .prepare(`UPDATE workspaces SET last_acceptance_sequence = last_acceptance_sequence + 1, updated_at = ? WHERE id = ?`)
      .bind(params.nowIso, params.workspaceId),
    params.db
      .prepare(`UPDATE chats SET activity_cursor = activity_cursor + 1, last_activity_at = ?, updated_at = ? WHERE id = ?`)
      .bind(params.nowIso, params.nowIso, params.chatId),
    params.db
      .prepare(
        `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, created_at, updated_at)
         VALUES (?, ?, ?, 'telegram', ?, ?, ?, 'queued', (SELECT last_acceptance_sequence FROM workspaces WHERE id = ?), ?, ?, ?)`,
      )
      .bind(
        messageInId,
        params.workspaceId,
        params.userId,
        params.externalId,
        params.fingerprint,
        params.persistedPayload,
        params.workspaceId,
        params.chatId,
        params.nowIso,
        params.nowIso,
      ),
    params.db
      .prepare(
        `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, source_job_id, executor_kind, status, model_key, thinking_snapshot_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 'agent', 'queued', (SELECT COALESCE(c.model_override, s.default_model, 'muse-13') FROM chats c LEFT JOIN workspace_settings s ON s.workspace_id = c.workspace_id WHERE c.id = ?), ?, ?, ?)`,
      )
      .bind(runId, params.workspaceId, params.chatId, messageInId, params.chatId, thinkingSnapshotJson, params.nowIso, params.nowIso),
    params.db
      .prepare(
        `INSERT INTO chat_messages (id, workspace_id, chat_id, author_user_id, author_kind, channel, inbound_message_id, client_message_id, content_text, media_id, run_id, sequence, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'member', 'telegram', ?, NULL, '', ?, ?, ?, ?, ?)`,
      )
      .bind(chatMessageId, params.workspaceId, params.chatId, params.userId, messageInId, mediaId, runId, nextSeq, params.nowIso, params.nowIso),
    params.db
      .prepare(
        `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, (SELECT activity_cursor FROM chats WHERE id = ?), 'message_accepted', ?, ?)`,
      )
      .bind(
        activityId,
        params.workspaceId,
        params.chatId,
        runId,
        params.chatId,
        JSON.stringify({ text: '', channel: 'telegram', media_id: mediaId, voice: true }),
        params.nowIso,
      ),
    params.db
      .prepare(
        `INSERT INTO outbox (id, workspace_id, destination, topic, payload_json, status, created_at, updated_at)
         VALUES (?, ?, 'workspace_actor', 'execute_run', ?, 'pending', ?, ?)`,
      )
      .bind(
        outboxId,
        params.workspaceId,
        JSON.stringify({ run_id: runId, chat_id: params.chatId, message_id: chatMessageId, channel: 'telegram' }),
        params.nowIso,
        params.nowIso,
      ),
    params.db
      .prepare(`UPDATE media_objects SET state = 'transcribing', updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .bind(params.nowIso, mediaId, params.workspaceId),
    transcriptionIntentStatement(params.db, {
      id: `mtr_${crypto.randomUUID()}`,
      workspaceId: params.workspaceId,
      mediaId,
      messageInId,
      runId,
      route: route.route,
      provider: route.route === 'groq_stt' ? 'groq' : null,
      model: route.route === 'groq_stt' ? route.sttModel : null,
      format: 'audio/ogg',
      languageHint: null,
      nowIso: params.nowIso,
    }),
  ]);

  return { messageInId, chatMessageId, runId, mediaId };
}

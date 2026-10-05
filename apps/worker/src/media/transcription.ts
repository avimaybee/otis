/**
 * @otis/worker/media/transcription
 * Durable voice transcription processor for Gate 010.
 *
 * Runs outside the workspace mutating-turn lease: it claims one logical
 * receipt per media object, decrypts the workspace Groq credential
 * server-side, sends validated private bytes to the fixed endpoint, and
 * commits the transcript conditionally against the claim. The agent run stays
 * queued until the transcript is ready, so a retry can never enqueue a second
 * logical run and a stale attempt can never overwrite a successor.
 *
 * Provider-only metadata is sanitized; transcript text is committed to the
 * receipt and mirrored onto the member's message so the existing agent text
 * loop reads it. Raw audio, keys, and upstream bodies are never logged.
 */

import {
  GROQ_STT_MODELS,
  transcribeWithGroq,
  type FetchFn,
  type GroqSttModel,
} from '@otis/agent';
import {
  decryptWorkspaceCredential,
  importWrappingKey,
} from '@otis/identity';
import { generateChatTitle } from '../inbox/repository.js';
import { failRunTerminal } from '../actor/dispatch.js';
import {
  loadMediaRow,
  loadTranscriptionRowById,
  markMediaExpired,
  type MediaRow,
  type TranscriptionRow,
} from './repository.js';

export interface TranscriptionProcessOptions {
  workspaceId?: string;
  jobId?: string;
  nowIso?: string;
  /**
   * Fresh clock for post-await state mutations. The commit guard must use the
   * actual moment of commit, not the pass-start time captured before the
   * provider call. Defaults to `nowIso` when supplied (fixed-clock tests),
   * otherwise the live clock. Tests may inject an advancing clock.
   */
  clock?: () => string;
  fetchFn?: FetchFn;
  wrappingKey?: CryptoKey;
  /** Base64url wrapping key material; imported when wrappingKey is absent. */
  wrappingKeyMaterial?: string;
  /** Platform fallback key for Groq from env.GROQ_API_KEY */
  platformApiKey?: string;
  limit?: number;
  claimTtlSeconds?: number;
  timeoutMs?: number;
  testHooks?: {
    afterClaim?: (info: { jobId: string; attempt: number }) => Promise<void>;
    beforeProviderCall?: (info: { jobId: string; mediaId: string }) => Promise<void>;
  };
}

export interface TranscriptionProcessResult {
  processed: number;
  ready: Array<{ workspaceId: string; runId: string; mediaId: string }>;
  failed: Array<{ workspaceId: string; mediaId: string; code: string }>;
  cancelled: number;
  deferred: number;
}

const CLAIM_TTL_SECONDS = 120;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

async function resolveWrappingKey(options: TranscriptionProcessOptions): Promise<CryptoKey | null> {
  if (options.wrappingKey) return options.wrappingKey;
  if (!options.wrappingKeyMaterial) return null;
  try {
    return await importWrappingKey(options.wrappingKeyMaterial);
  } catch {
    return null;
  }
}

interface ClaimedJob {
  job: TranscriptionRow;
  media: MediaRow;
}

async function claimJob(
  db: D1Database,
  jobId: string,
  claimOwner: string,
  nowIso: string,
  claimTtlSeconds: number,
): Promise<ClaimedJob | null> {
  const claimExpiresAt = addMs(nowIso, claimTtlSeconds * 1000);
  const result = await db
    .prepare(
      `UPDATE media_transcriptions
       SET state = 'running', claim_owner = ?, claim_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ?
       WHERE id = ?
         AND (
           (state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
           OR (state = 'running' AND (claim_expires_at IS NULL OR claim_expires_at <= ?))
         )
         AND attempt_count < max_attempts`,
    )
    .bind(claimOwner, claimExpiresAt, nowIso, jobId, nowIso, nowIso)
    .run();
  if ((result.meta.changes ?? 0) !== 1) return null;
  const job = await loadTranscriptionRowById(db, jobId);
  if (!job) return null;
  const media = await loadMediaRow(db, job.workspace_id, job.media_id);
  if (!media) return null;
  return { job, media };
}

async function cancelJob(
  db: D1Database,
  params: { jobId: string; claimOwner: string; reason: string; nowIso: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE media_transcriptions
       SET state = 'cancelled', error_code = 'cancelled', error_message = ?, claim_owner = NULL, claim_expires_at = NULL, updated_at = ?
       WHERE id = ? AND state = 'running' AND claim_owner = ?`,
    )
    .bind(params.reason, params.nowIso, params.jobId, params.claimOwner)
    .run();
}

/** Terminal failure: the receipt records the sanitized error; a queued run
 * fails visibly instead of waiting forever on a transcript that will not come. */
async function failJob(
  db: D1Database,
  params: {
    job: TranscriptionRow;
    media: MediaRow;
    claimOwner: string;
    code: string;
    message: string;
    nowIso: string;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE media_transcriptions
       SET state = 'failed', error_code = ?, error_message = ?, claim_owner = NULL, claim_expires_at = NULL, updated_at = ?
       WHERE id = ? AND state = 'running' AND claim_owner = ?`,
    )
    .bind(params.code, params.message, params.nowIso, params.job.id, params.claimOwner)
    .run();
  if ((result.meta.changes ?? 0) !== 1) return false;
  await failQueuedRun(db, {
    workspaceId: params.job.workspace_id,
    runId: params.job.run_id,
    errorCode: `transcription_${params.code}`,
    errorMessage: params.message,
    nowIso: params.nowIso,
  });
  return true;
}

/** Fails a still-queued voice run with the existing terminal-failure path. */
async function failQueuedRun(
  db: D1Database,
  params: { workspaceId: string; runId: string | null; errorCode: string; errorMessage: string; nowIso: string },
): Promise<void> {
  if (!params.runId) return;
  const run = await db
    .prepare(
      `SELECT id, workspace_id, chat_id, source_message_id, source_job_id, status, attempt_id, lease_fence
       FROM agent_runs WHERE id = ? AND workspace_id = ?`,
    )
    .bind(params.runId, params.workspaceId)
    .first<Record<string, unknown>>();
  if (!run || String(run['status']) !== 'queued') return;
  const outbox = await db
    .prepare(
      `SELECT id FROM outbox WHERE workspace_id = ? AND status IN ('pending', 'sending')
         AND json_extract(payload_json, '$.run_id') = ? LIMIT 1`,
    )
    .bind(params.workspaceId, params.runId)
    .first<{ id: string }>();
  await failRunTerminal(db, {
    run: {
      id: String(run['id']),
      workspace_id: String(run['workspace_id']),
      chat_id: String(run['chat_id']),
      source_message_id: run['source_message_id'] ? String(run['source_message_id']) : null,
      source_job_id: run['source_job_id'] ? String(run['source_job_id']) : null,
      status: String(run['status']),
      attempt_id: run['attempt_id'] ? String(run['attempt_id']) : null,
      lease_fence: Number(run['lease_fence'] ?? 0),
    },
    expectedStatus: 'queued',
    expectedAttemptId: run['attempt_id'] ? String(run['attempt_id']) : null,
    errorCode: params.errorCode,
    errorMessage: params.errorMessage,
    outboxId: outbox?.id ?? null,
    runStatus: 'failed',
    nowIso: params.nowIso,
  });
}

/** Reschedules a retryable failure while attempts remain and retention allows. */
async function rescheduleJob(
  db: D1Database,
  params: { job: TranscriptionRow; claimOwner: string; delayMs: number; nowIso: string },
): Promise<boolean> {
  const nextAttemptAt = addMs(params.nowIso, params.delayMs);
  const result = await db
    .prepare(
      `UPDATE media_transcriptions
       SET state = 'pending', next_attempt_at = ?, claim_owner = NULL, claim_expires_at = NULL, updated_at = ?
       WHERE id = ? AND state = 'running' AND claim_owner = ?`,
    )
    .bind(nextAttemptAt, params.nowIso, params.job.id, params.claimOwner)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

interface TranscriptCommit {
  transcriptText: string;
  language: string | null;
}

/**
 * Commits the canonical transcript receipt conditionally. The guard rechecks
 * the claim owner, an unexpired claim, unexpired media, the uploader's live
 * membership, and that the run is still queued, all at the actual commit
 * moment (`commitNowIso`), so a removed member, expired audio/claim, stale
 * attempt or a Stop can never publish late. The message text is mirrored only
 * for the current receipt.
 */
async function commitTranscript(
  db: D1Database,
  params: {
    job: TranscriptionRow;
    media: MediaRow;
    claimOwner: string;
    commit: TranscriptCommit;
    /** Fresh clock read at the commit boundary, never the pass-start time. */
    commitNowIso: string;
  },
): Promise<boolean> {
  const guard = `(
    SELECT 1 FROM media_transcriptions t
    JOIN media_objects m ON m.id = t.media_id
    JOIN workspace_users wu
      ON wu.workspace_id = m.workspace_id AND wu.user_id = m.uploader_user_id
    WHERE t.id = ? AND t.state = 'running' AND t.claim_owner = ?
      AND t.claim_expires_at > ?
      AND m.state IN ('validated', 'transcribing')
      AND m.expires_at > ?
      AND (t.run_id IS NULL OR EXISTS (SELECT 1 FROM agent_runs r WHERE r.id = t.run_id AND r.status = 'queued'))
  )`;
  const message = await db
    .prepare(`SELECT id, chat_id, content_text FROM chat_messages WHERE run_id = ? AND media_id = ?`)
    .bind(params.job.run_id, params.media.id)
    .first<{ id: string; chat_id: string; content_text: string }>();
  const existingText = message?.content_text?.trim() ?? '';
  const nextText = existingText
    ? `${existingText}\n\n[Voice transcript] ${params.commit.transcriptText}`
    : params.commit.transcriptText;

  const statements: D1PreparedStatement[] = [
    db
      .prepare(`INSERT INTO acceptance_guards (id, guard_ok) VALUES (?, ${guard})`)
      .bind(
        `guard_${crypto.randomUUID()}`,
        params.job.id,
        params.claimOwner,
        params.commitNowIso,
        params.commitNowIso,
      ),
    db
      .prepare(
        `UPDATE media_transcriptions
         SET state = 'ready', transcript_text = ?, transcript_language = ?, committed_at = ?,
             claim_owner = NULL, claim_expires_at = NULL, updated_at = ?
         WHERE id = ? AND state = 'running' AND claim_owner = ?`,
      )
      .bind(
        params.commit.transcriptText,
        params.commit.language,
        params.commitNowIso,
        params.commitNowIso,
        params.job.id,
        params.claimOwner,
      ),
    db
      .prepare(
        `UPDATE media_objects SET state = 'ready', updated_at = ?
         WHERE id = ? AND workspace_id = ? AND state IN ('validated', 'transcribing')`,
      )
      .bind(params.commitNowIso, params.media.id, params.media.workspace_id),
  ];
  if (message) {
    statements.push(
      db
        .prepare(`UPDATE chat_messages SET content_text = ?, updated_at = ? WHERE id = ?`)
        .bind(nextText, params.commitNowIso, message.id),
    );
    if (nextText) {
      const autoTitle = generateChatTitle(nextText);
      statements.push(
        db
          .prepare(
            `UPDATE chats SET title = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND title IN ('New conversation', 'Untitled conversation')`,
          )
          .bind(autoTitle, params.commitNowIso, message.chat_id, params.media.workspace_id),
      );
    }
  }
  try {
    await db.batch(statements);
    return true;
  } catch (err) {
    const s = String(err);
    if (s.includes('SQLITE_CONSTRAINT') || s.includes('guard_ok') || s.includes('PRIMARY KEY')) {
      return false;
    }
    throw err;
  }
}

async function discoverDueJobIds(
  db: D1Database,
  params: { workspaceId?: string; jobId?: string; nowIso: string; limit: number },
): Promise<string[]> {
  const filters: string[] = [];
  const binds: Array<string | number> = [];
  if (params.jobId) {
    filters.push(`id = ?`);
    binds.push(params.jobId);
  }
  if (params.workspaceId) {
    filters.push(`workspace_id = ?`);
    binds.push(params.workspaceId);
  }
  binds.push(params.nowIso, params.nowIso, params.limit);
  const { results } = await db
    .prepare(
      `SELECT id FROM media_transcriptions
       WHERE ${filters.length ? `${filters.join(' AND ')} AND ` : ''}(
         (state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (state = 'running' AND (claim_expires_at IS NULL OR claim_expires_at <= ?))
       )
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .bind(...binds)
    .all<{ id: string }>();
  return (results ?? []).map((row) => row.id);
}

/**
 * Processes bounded due transcription jobs. Returns which runs became ready
 * so the caller can publish a dispatch wake-up; the durable outbox row is
 * already pending, so a lost wake-up only delays dispatch until cron.
 */
export async function processTranscriptionJobs(
  db: D1Database,
  storage: R2Bucket,
  options: TranscriptionProcessOptions = {},
): Promise<TranscriptionProcessResult> {
  const clock = options.clock ?? (() => options.nowIso ?? new Date().toISOString());
  const passNowIso = clock();
  const limit = Math.min(options.limit ?? 3, 10);
  const claimTtlSeconds = options.claimTtlSeconds ?? CLAIM_TTL_SECONDS;
  const result: TranscriptionProcessResult = { processed: 0, ready: [], failed: [], cancelled: 0, deferred: 0 };
  const wrappingKey = await resolveWrappingKey(options);

  const jobIds = await discoverDueJobIds(db, {
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(options.jobId ? { jobId: options.jobId } : {}),
    nowIso: passNowIso,
    limit,
  });

  for (const jobId of jobIds) {
    const claimOwner = `stt_${crypto.randomUUID()}`;
    const claimed = await claimJob(db, jobId, claimOwner, passNowIso, claimTtlSeconds);
    if (!claimed) continue;
    result.processed += 1;
    const { job, media } = claimed;
    if (options.testHooks?.afterClaim) {
      await options.testHooks.afterClaim({ jobId, attempt: job.attempt_count });
    }

    // Preflight validity: no provider call for stale/cancelled/expired media.
    if (media.state === 'rejected' || media.state === 'expired' || media.state === 'deleted') {
      await cancelJob(db, { jobId, claimOwner, reason: 'Media is no longer valid.', nowIso: clock() });
      result.cancelled += 1;
      continue;
    }
    if (media.expires_at <= clock()) {
      await markMediaExpired(db, { workspaceId: media.workspace_id, mediaId: media.id, nowIso: clock() });
      await cancelJob(db, { jobId, claimOwner, reason: 'Audio expired before transcription.', nowIso: clock() });
      result.cancelled += 1;
      continue;
    }
    const member = await db
      .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .bind(media.workspace_id, media.uploader_user_id)
      .first();
    if (!member) {
      await failJob(db, {
        job,
        media,
        claimOwner,
        code: 'member_removed',
        message: 'The member who sent this recording is no longer in the workspace.',
        nowIso: clock(),
      });
      result.failed.push({ workspaceId: media.workspace_id, mediaId: media.id, code: 'member_removed' });
      continue;
    }
    if (job.run_id) {
      const run = await db
        .prepare(`SELECT status FROM agent_runs WHERE id = ? AND workspace_id = ?`)
        .bind(job.run_id, media.workspace_id)
        .first<{ status: string }>();
      if (!run || run.status !== 'queued') {
        // Stop or a successor terminal state: reject late publication.
        await cancelJob(db, { jobId, claimOwner, reason: 'The conversation run is no longer queued.', nowIso: clock() });
        result.cancelled += 1;
        continue;
      }
    }

    if (job.route !== 'groq_stt' || job.provider !== 'groq' || !job.model) {
      await failJob(db, {
        job,
        media,
        claimOwner,
        code: 'route_unavailable',
        message: 'The verified transcription route for this recording is no longer available.',
        nowIso: clock(),
      });
      result.failed.push({ workspaceId: media.workspace_id, mediaId: media.id, code: 'route_unavailable' });
      continue;
    }
    const model = GROQ_STT_MODELS.find((candidate) => candidate === job.model);
    if (!model) {
      await failJob(db, {
        job,
        media,
        claimOwner,
        code: 'route_unavailable',
        message: 'The pinned transcription model is not an approved STT candidate.',
        nowIso: clock(),
      });
      result.failed.push({ workspaceId: media.workspace_id, mediaId: media.id, code: 'route_unavailable' });
      continue;
    }
    let rawKey: string | null = null;
    if (wrappingKey) {
      try {
        const decrypted = await decryptWorkspaceCredential(db, {
          workspaceId: media.workspace_id,
          provider: 'groq',
          wrappingKey,
        });
        rawKey = decrypted.rawKey;
      } catch {
        // Workspace credential not found or unreadable; fallback to platform key if present
      }
    }
    if (!rawKey && options.platformApiKey) {
      rawKey = options.platformApiKey;
    }

    if (!rawKey) {
      const isUnconfigured = !wrappingKey && !options.platformApiKey;
      const code = isUnconfigured ? 'stt_unconfigured' : 'stt_credential_unavailable';
      const message = isUnconfigured
        ? 'Voice transcription is not configured on this server.'
        : 'No Groq transcription key is configured for this workspace.';
      await failJob(db, {
        job,
        media,
        claimOwner,
        code,
        message,
        nowIso: clock(),
      });
      result.failed.push({ workspaceId: media.workspace_id, mediaId: media.id, code });
      continue;
    }

    const object = await storage.get(media.object_key);
    if (!object) {
      await failJob(db, {
        job,
        media,
        claimOwner,
        code: 'media_missing',
        message: 'The recording bytes are no longer available.',
        nowIso: clock(),
      });
      result.failed.push({ workspaceId: media.workspace_id, mediaId: media.id, code: 'media_missing' });
      continue;
    }
    const bytes = new Uint8Array(await object.arrayBuffer());

    if (options.testHooks?.beforeProviderCall) {
      await options.testHooks.beforeProviderCall({ jobId, mediaId: media.id });
    }

    const transcription = await transcribeWithGroq({
      apiKey: rawKey,
      model: model as GroqSttModel,
      bytes,
      filename: `voice-${media.id}.${media.format === 'audio/ogg' ? 'ogg' : media.format === 'audio/mp4' ? 'm4a' : 'webm'}`,
      mimeType: media.format ?? 'application/octet-stream',
      ...(job.language_hint ? { language: job.language_hint } : {}),
      fetchFn: options.fetchFn ?? fetch,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });

    if (transcription.ok) {
      const transcriptText = transcription.text.trim();
      if (!transcriptText) {
        await failJob(db, {
          job,
          media,
          claimOwner,
          code: 'empty_transcript',
          message: 'No speech was detected in this recording.',
          nowIso: clock(),
        });
        result.failed.push({ workspaceId: media.workspace_id, mediaId: media.id, code: 'empty_transcript' });
        continue;
      }
      // The commit guard rechecks membership, media/claim expiry and the
      // queued run at this fresh clock read, not the pass-start time.
      const committed = await commitTranscript(db, {
        job,
        media,
        claimOwner,
        commit: { transcriptText, language: transcription.language },
        commitNowIso: clock(),
      });
      if (!committed) {
        // Stale attempt: touch nothing. A successor-owned job is never
        // cancelled or failed from here.
        result.deferred += 1;
        continue;
      }
      result.ready.push({ workspaceId: media.workspace_id, runId: job.run_id ?? '', mediaId: media.id });
      continue;
    }

    const retryable =
      transcription.retryable &&
      job.attempt_count < job.max_attempts &&
      transcription.code !== 'invalid_credential';
    if (retryable) {
      const backoff = Math.min(
        transcription.retryAfterMs ?? 2000 * 2 ** Math.max(0, job.attempt_count - 1),
        MAX_BACKOFF_MS,
      );
      const retryNowIso = clock();
      const nextAttemptAt = addMs(retryNowIso, backoff);
      if (nextAttemptAt < media.expires_at) {
        const rescheduled = await rescheduleJob(db, { job, claimOwner, delayMs: backoff, nowIso: retryNowIso });
        if (rescheduled) {
          result.deferred += 1;
          continue;
        }
      }
    }
    const code = transcription.code;
    await failJob(db, {
      job,
      media,
      claimOwner,
      code,
      message: transcription.message,
      nowIso: clock(),
    });
    result.failed.push({ workspaceId: media.workspace_id, mediaId: media.id, code });
  }

  return result;
}

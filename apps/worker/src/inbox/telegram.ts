/**
 * @otis/worker/inbox/telegram
 * Telegram inbound message routing, account linking, media handling, and acceptance.
 * In accordance with docs/contracts.md and docs/archive/plans/004-inbound-routing.md.
 */

import {
  normalizeTelegramUpdate,
  type NormalizedTelegramUpdate,
} from '@otis/channels';
import { parseCommandText } from '@otis/commands';
import { sha256 } from '@otis/identity';
import { resumeRun } from '../actor/dispatch.js';
import { createChat, generateChatTitle, resolveThinkingSnapshot, updateChatTitle } from './repository.js';
import { buildTelegramDeliveryInserts, sendTelegramText, type TelegramSendFetch } from './telegramDelivery.js';
import { executeTelegramCommand } from './telegramCommands.js';
import type { PlatformKeys } from '../providers/service.js';
import {
  acceptTelegramVoiceMessage,
  extractTelegramVoiceMetadata,
  TelegramVoiceError,
  type TelegramFileFetch,
} from '../media/telegramVoice.js';

export interface TelegramInboundResult {
  status:
    | 'accepted'
    | 'linked'
    | 'unrouted'
    | 'unsupported'
    | 'confirmation_required'
    | 'conflict'
    | 'ignored';
  reason?: string;
  message_in_id?: string;
  run_id?: string;
  workspace_id?: string;
  user_id?: string;
}

/**
 * Redacts sensitive arguments (such as one-time link codes) from raw Telegram updates before persistence.
 */
function getPersistedPayload(update: unknown, startCode?: string): string {
  try {
    const raw = JSON.stringify(update);
    if (startCode && startCode.trim().length > 0) {
      return raw.replaceAll(startCode, '[REDACTED_LINK_CODE]');
    }
    return raw;
  } catch {
    return JSON.stringify({ redacted: true });
  }
}

/**
 * Records one administrative reply (linking, expiry, conflict, guidance).
 *
 * Workspace-scoped replies persist with their outbox delivery in one commit.
 * Workspace-less replies (expired codes, conflicting bindings, selection
 * guidance) cannot be represented by the existing outbox — `workspace_id`
 * is NOT NULL with a workspace FK — so they are persisted and then sent
 * best-effort once through the injected transport: no retry, no claim, no
 * model call, and a duplicate webhook never resends because the persisted
 * source row makes the dedupe branch return early. Unknown delivery is not
 * claimed successful. The delivery key derives from the update so any
 * workspace-scoped row stays idempotent under redelivery.
 */
async function replyTelegramAdmin(
  db: D1Database,
  input: {
    workspaceId: string | null;
    userId: string | null;
    chatId: string | null;
    storeStatus: 'processed' | 'unrouted';
    errorMessage?: string;
    botInstallationId: string;
    telegramUserId: string;
    telegramChatId: string;
    externalId: string;
    fingerprint: string;
    persistedPayload: string;
    now: string;
    text: string;
    resultStatus: TelegramInboundResult['status'];
    reason?: string;
  },
  options?: { botToken?: string; adminTransport?: TelegramSendFetch },
): Promise<TelegramInboundResult> {
  const minId = `min_${crypto.randomUUID()}`;
  const delivery = input.workspaceId
    ? await buildTelegramDeliveryInserts(db, {
      workspaceId: input.workspaceId,
      userId: input.userId ?? '',
      chatId: input.chatId ?? '',
      sourceMessageId: minId,
      runId: null,
      kind: 'admin',
      key: minId,
      text: input.text,
      target: {
        botInstallationId: input.botInstallationId,
        telegramUserId: input.telegramUserId,
        telegramChatId: input.telegramChatId,
      },
    })
    : [];
  await db.batch([
    db
      .prepare(
        `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, error_message, created_at, updated_at)
         VALUES (?, ?, ?, 'telegram', ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .bind(
        minId,
        input.workspaceId,
        input.userId,
        input.externalId,
        input.fingerprint,
        wrapPersistedPayload(input.persistedPayload, { result: input.resultStatus }),
        input.storeStatus,
        input.chatId,
        input.errorMessage ?? null,
        input.now,
        input.now,
      ),
    ...delivery,
  ]);
  if (!input.workspaceId && options?.adminTransport && options.botToken) {
    // One bounded best-effort attempt; the outcome is not recorded as
    // delivered anywhere and never retried automatically.
    await sendTelegramText(options.botToken, input.telegramChatId, input.text, undefined, options.adminTransport);
  }
  return {
    status: input.resultStatus,
    ...(input.reason ? { reason: input.reason } : {}),
    message_in_id: minId,
    ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
    ...(input.userId ? { user_id: input.userId } : {}),
  };
}

/**
 * Concise link confirmation from trusted records only: the member's
 * display name and the validated workspace name. Never echoes codes,
 * keys, emails or UIDs.
 */
async function telegramConfirmationCopy(db: D1Database, userId: string, workspaceId: string): Promise<string> {
  const user = await db
    .prepare(`SELECT display_name FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ display_name: string | null }>();
  const workspace = await db
    .prepare(`SELECT name FROM workspaces WHERE id = ?`)
    .bind(workspaceId)
    .first<{ name: string }>();
  const displayName = user?.display_name?.trim() ? String(user.display_name) : 'there';
  const workspaceName = workspace?.name?.trim() ? String(workspace.name) : 'your workspace';
  return `Connected to ${displayName} in ${workspaceName}. Send me a note whenever you're ready.`;
}

/**
 * Native-reply clarification answers. Maps the external bot message ID
 * through this identity/workspace's delivered question delivery to the
 * exact clarification, verifies requester/chat/pending/membership, then
 * persists the answer and resumes with the existing resumeRun (explicit
 * clarificationId, server-derived author). Returns null when the reply
 * does not target a resumable question — the caller falls through to
 * ordinary acceptance. Obsolete or foreign targets are recorded as
 * ordinary text plus a kept admin explanation, never silently rerouted.
 */
async function acceptTelegramReply(
  db: D1Database,
  input: {
    workspaceId: string;
    userId: string;
    telegramUserId: string;
    telegramChatId: string;
    botInstallationId: string;
    chatId: string;
    externalId: string;
    fingerprint: string;
    persistedPayload: string;
    text: string;
    replyToMessageId: string;
    now: string;
  },
): Promise<TelegramInboundResult | null> {
  const question = await db
    .prepare(
      `SELECT id, payload_json FROM outbox
       WHERE destination = 'telegram' AND workspace_id = ?
         AND json_extract(payload_json, '$.kind') = 'question'
         AND json_extract(payload_json, '$.user_id') = ?
         AND json_extract(payload_json, '$.telegram_user_id') = ?
         AND CAST(json_extract(payload_json, '$.telegram_message_id') AS TEXT) = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(input.workspaceId, input.userId, input.telegramUserId, input.replyToMessageId)
    .first<{ id: string; payload_json: string }>();
  if (!question) return null;
  let clarificationId: string | null = null;
  try {
    const payload = JSON.parse(String(question.payload_json ?? '{}')) as { clarification_id?: unknown };
    if (typeof payload.clarification_id === 'string' && payload.clarification_id) {
      clarificationId = payload.clarification_id;
    }
  } catch {
    clarificationId = null;
  }
  if (!clarificationId) return null;

  const clar = await db
    .prepare(
      `SELECT id, chat_id, run_id, requester_user_id, status FROM pending_clarifications
       WHERE id = ? AND workspace_id = ?`,
    )
    .bind(clarificationId, input.workspaceId)
    .first<Record<string, unknown>>();
  const runRow = clar && typeof clar['run_id'] === 'string'
    ? await db
      .prepare(`SELECT status FROM agent_runs WHERE id = ? AND workspace_id = ?`)
      .bind(String(clar['run_id']), input.workspaceId)
      .first<{ status: string }>()
    : null;
  const resumable =
    !!clar &&
    clar['status'] === 'pending' &&
    (!clar['chat_id'] || String(clar['chat_id']) === input.chatId) &&
    (!clar['requester_user_id'] || String(clar['requester_user_id']) === input.userId) &&
    runRow?.status === 'waiting_for_input';
  if (!resumable) {
    // Obsolete or foreign target: keep the text as an ordinary message and
    // explain, never route it to a different question.
    const accepted = await acceptTelegramTextMessage(db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      chatId: input.chatId,
      externalId: input.externalId,
      fingerprint: input.fingerprint,
      persistedPayload: input.persistedPayload,
      text: input.text,
      now: input.now,
    });
    await db.batch(
      await buildTelegramDeliveryInserts(db, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        chatId: input.chatId,
        sourceMessageId: accepted.messageInId,
        runId: null,
        kind: 'admin',
        key: `obsolete:${input.externalId}`,
        text: 'I can\u2019t answer that question here \u2014 it may be outdated or from another chat. Your message was kept as a new note.',
        target: {
          botInstallationId: input.botInstallationId,
          telegramUserId: input.telegramUserId,
          telegramChatId: input.telegramChatId,
        },
      }),
    );
    return {
      status: 'accepted',
      message_in_id: accepted.messageInId,
      run_id: accepted.runId,
      workspace_id: input.workspaceId,
      user_id: input.userId,
    };
  }

  // Durable answer acceptance: source row + author chat bubble carrying the
  // waiting run's ID + activity, atomically. The envelope keeps the target
  // clarification ID so a crash before resume is repaired on redelivery.
  const minId = `min_${crypto.randomUUID()}`;
  const runId = String(clar!['run_id']);
  const envelope = JSON.stringify({
    update: JSON.parse(input.persistedPayload),
    telegram: { result: 'accepted', reply_to: input.replyToMessageId, clarification_id: clarificationId, text: input.text },
  });
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO acceptance_guards (id, guard_ok)
           VALUES (
             ?,
             (SELECT 1
              FROM workspace_users wu
              JOIN chats c ON c.id = ? AND c.workspace_id = wu.workspace_id AND c.author_user_id = wu.user_id
              WHERE wu.workspace_id = ? AND wu.user_id = ?)
           )
           ON CONFLICT(id) DO UPDATE SET guard_ok = excluded.guard_ok`,
        )
        .bind(`guard_tg_accept_${input.workspaceId}`, input.chatId, input.workspaceId, input.userId),
      db
        .prepare(
          `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, created_at, updated_at)
           VALUES (?, ?, ?, 'telegram', ?, ?, ?, 'processed', NULL, ?, ?, ?)`,
        )
        .bind(
          minId, input.workspaceId, input.userId, input.externalId, input.fingerprint, envelope,
          input.chatId, input.now, input.now,
        ),
      db
        .prepare(
          `INSERT INTO chat_messages (id, workspace_id, chat_id, author_user_id, author_kind, channel, inbound_message_id, client_message_id, content_text, media_id, run_id, sequence, created_at, updated_at)
           SELECT ?, ?, ?, ?, 'member', 'telegram', ?, NULL, ?, NULL, ?, COALESCE(MAX(sequence), 0) + 1, ?, ? FROM chat_messages WHERE chat_id = ?`,
        )
        .bind(
          `msg_${crypto.randomUUID()}`, input.workspaceId, input.chatId, input.userId, minId,
          input.text, runId, input.now, input.now, input.chatId,
        ),
      db
        .prepare(`UPDATE chats SET activity_cursor = activity_cursor + 1, last_activity_at = ?, updated_at = ? WHERE id = ?`)
        .bind(input.now, input.now, input.chatId),
      db
        .prepare(
          `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
           SELECT ?, ?, ?, ?, activity_cursor, 'message_accepted', ?, ? FROM chats WHERE id = ?`,
        )
        .bind(
          `act_${crypto.randomUUID()}`, input.workspaceId, input.chatId, runId,
          JSON.stringify({ text: input.text, channel: 'telegram', clarification_id: clarificationId }), input.now, input.chatId,
        ),
    ]);
  } catch {
    // Guard abort (verified revocation) or storage failure: nothing was
    // persisted by this batch; fall through to ordinary acceptance, which
    // performs its own verification and unrouted mapping.
    return null;
  }

  // Resume through the existing machinery with the explicit target and
  // server-derived author. A rejected detail keeps the question pending.
  const resumed = await resumeRun(db, {
    workspaceId: input.workspaceId,
    runId,
    answer: { messageId: minId, clarificationId, authorUserId: input.userId, text: input.text },
  });
  if (resumed.resumed || resumed.replay) {
    return {
      status: 'accepted',
      message_in_id: minId,
      run_id: runId,
      workspace_id: input.workspaceId,
      user_id: input.userId,
    };
  }

  // Resume rejected the answer detail (for example an unreadable date) or
  // lost a race: keep the pending question and the answer source, and ask
  // concisely for the detail that is actually needed.
  const stillPending = await db
    .prepare(`SELECT status FROM pending_clarifications WHERE id = ? AND workspace_id = ?`)
    .bind(clarificationId, input.workspaceId)
    .first<{ status: string }>();
  if (stillPending?.status === 'pending') {
    await db.batch(
      await buildTelegramDeliveryInserts(db, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        chatId: input.chatId,
        sourceMessageId: minId,
        runId: null,
        kind: 'admin',
        key: `answer-detail:${input.externalId}`,
        text: 'I couldn\u2019t use that answer yet. Reply with the missing detail \u2014 for a date, something like 2026-10-15 works.',
      }),
    );
  }
  return {
    status: 'accepted',
    message_in_id: minId,
    run_id: runId,
    workspace_id: input.workspaceId,
    user_id: input.userId,
  };
}

/**
 * Durable acceptance of one ordinary Telegram text message: source row,
 * agent run (with pinned model/thinking like web acceptance), chat bubble,
 * activity and dispatch intent commit atomically. Returns the stable IDs.
 * Storage failures propagate for retryable errors; callers map membership
 * revocation to unrouted.
 */
async function acceptTelegramTextMessage(
  db: D1Database,
  input: {
    workspaceId: string;
    userId: string;
    chatId: string;
    externalId: string;
    fingerprint: string;
    persistedPayload: string;
    text: string;
    now: string;
  },
): Promise<{ messageInId: string; chatMessageId: string; runId: string }> {
  const messageInId = `min_${crypto.randomUUID()}`;
  const chatMessageId = `msg_${crypto.randomUUID()}`;
  const runId = `run_${crypto.randomUUID()}`;
  const outboxId = `out_${crypto.randomUUID()}`;
  const activityId = `act_${crypto.randomUUID()}`;

  const seqRow = await db
    .prepare(`SELECT COALESCE(MAX(sequence), 0) as max_seq FROM chat_messages WHERE chat_id = ?`)
    .bind(input.chatId)
    .first<{ max_seq: number }>();
  const nextMsgSeq = (seqRow?.max_seq || 0) + 1;
  const { thinkingSnapshotJson } = await resolveThinkingSnapshot(db, {
    workspaceId: input.workspaceId,
    chatId: input.chatId,
  });

  await db.batch([
    db
      .prepare(
        `INSERT INTO acceptance_guards (id, guard_ok)
         VALUES (
           ?,
           (SELECT 1
            FROM workspace_users wu
            JOIN chats c ON c.id = ? AND c.workspace_id = wu.workspace_id AND c.author_user_id = wu.user_id
            WHERE wu.workspace_id = ? AND wu.user_id = ?)
         )
         ON CONFLICT(id) DO UPDATE SET guard_ok = excluded.guard_ok`
      )
      .bind(
        `guard_tg_clar_${input.workspaceId}`,
        input.chatId,
        input.workspaceId,
        input.userId,
      ),

    db
      .prepare(
        `UPDATE workspaces SET last_acceptance_sequence = last_acceptance_sequence + 1, updated_at = ? WHERE id = ?`
      )
      .bind(input.now, input.workspaceId),

    db
      .prepare(
        `UPDATE chats SET activity_cursor = activity_cursor + 1, last_activity_at = ?, updated_at = ? WHERE id = ?`
      )
      .bind(input.now, input.now, input.chatId),

    db
      .prepare(
        `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, created_at, updated_at)
         VALUES (?, ?, ?, 'telegram', ?, ?, ?, 'queued', (SELECT last_acceptance_sequence FROM workspaces WHERE id = ?), ?, ?, ?)`
      )
      .bind(
        messageInId,
        input.workspaceId,
        input.userId,
        input.externalId,
        input.fingerprint,
        input.persistedPayload,
        input.workspaceId,
        input.chatId,
        input.now,
        input.now,
      ),

    db
      .prepare(
        `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, source_job_id, executor_kind, status, model_key, thinking_snapshot_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 'agent', 'queued', (SELECT COALESCE(c.model_override, s.default_model, 'muse-13') FROM chats c LEFT JOIN workspace_settings s ON s.workspace_id = c.workspace_id WHERE c.id = ?), ?, ?, ?)`
      )
      .bind(runId, input.workspaceId, input.chatId, messageInId, input.chatId, thinkingSnapshotJson, input.now, input.now),

    db
      .prepare(
        `INSERT INTO chat_messages (id, workspace_id, chat_id, author_user_id, author_kind, channel, inbound_message_id, client_message_id, content_text, media_id, run_id, sequence, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'member', 'telegram', ?, NULL, ?, NULL, ?, ?, ?, ?)`
      )
      .bind(
        chatMessageId,
        input.workspaceId,
        input.chatId,
        input.userId,
        messageInId,
        input.text,
        runId,
        nextMsgSeq,
        input.now,
        input.now,
      ),

    db
      .prepare(
        `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, (SELECT activity_cursor FROM chats WHERE id = ?), 'message_accepted', ?, ?)`
      )
      .bind(
        activityId,
        input.workspaceId,
        input.chatId,
        runId,
        input.chatId,
        JSON.stringify({ text: input.text, channel: 'telegram' }),
        input.now,
      ),

    db
      .prepare(
        `INSERT INTO outbox (id, workspace_id, destination, topic, payload_json, status, created_at, updated_at)
         VALUES (?, ?, 'workspace_actor', 'execute_run', ?, 'pending', ?, ?)`
      )
      .bind(
        outboxId,
        input.workspaceId,
        JSON.stringify({
          run_id: runId,
          chat_id: input.chatId,
          message_id: chatMessageId,
          channel: 'telegram',
        }),
        input.now,
        input.now,
      ),
  ]);
  return { messageInId, chatMessageId, runId };
}

/**
 * Extracts the stored target clarification from an accepted answer envelope;
 * null for any other persisted payload.
 */
function parseClarificationTarget(rawPayload: unknown): string | null {
  try {
    const parsed = JSON.parse(String(rawPayload ?? '{}')) as { telegram?: { clarification_id?: unknown } };
    const id = parsed?.telegram?.clarification_id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/** Explicit result status recorded by administrative envelopes, if any. */
function parseStoredTelegramResult(rawPayload: unknown): string | null {
  try {
    const parsed = JSON.parse(String(rawPayload ?? '{}')) as { telegram?: { result?: unknown } };
    const result = parsed?.telegram?.result;
    return typeof result === 'string' && result ? result : null;
  } catch {
    return null;
  }
}

/**
 * Maps a stored inbox status (which is deliberately wider than the inbound
 * result union) to the truthful result for a redelivered update. Explicit
 * envelope results win; ordinary queued/processed messages replay as
 * accepted, not as an out-of-union string.
 */
function mapStoredTelegramStatus(
  stored: string,
  envelopeResult: string | null,
): TelegramInboundResult['status'] {
  const allowed: TelegramInboundResult['status'][] = [
    'accepted', 'linked', 'unrouted', 'unsupported', 'confirmation_required', 'conflict', 'ignored',
  ];
  if (envelopeResult && (allowed as string[]).includes(envelopeResult)) {
    return envelopeResult as TelegramInboundResult['status'];
  }
  switch (stored) {
    case 'unrouted':
      return 'unrouted';
    case 'unsupported':
      return 'unsupported';
    case 'waiting_for_input':
      return 'confirmation_required';
    default:
      return 'accepted';
  }
}

/** Wraps the redacted update with bounded telegram metadata for replay. */
function wrapPersistedPayload(persistedPayload: string, telegram: Record<string, unknown>): string {
  try {
    return JSON.stringify({ update: JSON.parse(persistedPayload), telegram });
  } catch {
    return persistedPayload;
  }
}

/**
 * Stored answer text for a persisted reply row: the author chat bubble
 * first, then the envelope's own text as fallback.
 */
async function readStoredAnswerText(db: D1Database, messageInId: string): Promise<string> {
  const bubble = await db
    .prepare(`SELECT content_text FROM chat_messages WHERE inbound_message_id = ? ORDER BY sequence DESC LIMIT 1`)
    .bind(messageInId)
    .first<{ content_text: string | null }>();
  return bubble?.content_text ?? '';
}

/**
 * Accepts an incoming Telegram update.
 *
 * Options carry deployment-specific command addressing; pure inbox
 * acceptance never needs transport config (no token required).
 */
export async function acceptTelegramInbound(
  db: D1Database,
  botInstallationId: string,
  update: unknown,
  options?: {
    botUsername?: string;
    botToken?: string;
    adminTransport?: TelegramSendFetch;
    /** Private R2 binding; voice ingest is skipped when absent. */
    storage?: R2Bucket;
    /** Bounded Telegram file transport; tests inject a fake, production passes global fetch. */
    fileTransport?: TelegramFileFetch;
    platformKeys?: PlatformKeys;
  },
): Promise<TelegramInboundResult> {
  let normalized: NormalizedTelegramUpdate;
  try {
    normalized = normalizeTelegramUpdate(update, botInstallationId);
  } catch (err) {
    return {
      status: 'ignored',
      reason: `Malformed update: ${String(err)}`,
    };
  }

  if (!normalized.isPrivateChat) {
    return {
      status: 'ignored',
      reason: 'Non-private chat updates are not admitted',
    };
  }

  // Another bot's output is never conversational input.
  if (normalized.senderIsBot) {
    return {
      status: 'ignored',
      reason: 'Bot senders are not admitted',
    };
  }

  // Redact one-time link code from persisted raw payload to prevent plaintext credential leaks
  const persistedPayload = getPersistedPayload(update, normalized.startCode);
  const fingerprint = await sha256(persistedPayload);
  const now = new Date().toISOString();

  // 1. Check Deduplication on (channel = 'telegram', external_id).
  // A redelivered update returns the stored result with its stable run ID
  // and creates nothing new; a conflicting reused key (same update ID,
  // different content/identity) is likewise never a new command or run.
  const existing = await db
    .prepare(
      `SELECT id, status, workspace_id, user_id, chat_id, payload_fingerprint, raw_payload FROM messages_in WHERE channel = 'telegram' AND external_id = ?`
    )
    .bind(normalized.externalId)
    .first<Record<string, unknown>>();

  if (existing) {
    const matches = existing['payload_fingerprint'] === fingerprint;
    const storedId = String(existing['id']);
    let runId: string | undefined;
    if (
      matches &&
      (existing['status'] === 'accepted' ||
        existing['status'] === 'processed' ||
        existing['status'] === 'queued' ||
        existing['status'] === 'processing')
    ) {
      const run = await db
        .prepare(`SELECT id FROM agent_runs WHERE source_message_id = ? ORDER BY created_at DESC LIMIT 1`)
        .bind(storedId)
        .first<{ id: string }>();
      if (run) runId = run.id;
    }
    // Durable replay repair: a crash between clarification-answer acceptance
    // and resume is repaired from the stored envelope target, never lost or
    // guessed. An already-resolved clarification replays without effect.
    if (matches && existing['status'] === 'processed' && existing['workspace_id'] && existing['user_id']) {
      const clarificationId = parseClarificationTarget(existing['raw_payload']);
      if (clarificationId) {
        const clar = await db
          .prepare(`SELECT run_id, status FROM pending_clarifications WHERE id = ? AND workspace_id = ?`)
          .bind(clarificationId, String(existing['workspace_id']))
          .first<{ run_id: string | null; status: string }>();
        if (clar && clar.status === 'pending' && clar.run_id) {
          const text = await readStoredAnswerText(db, storedId);
          await resumeRun(db, {
            workspaceId: String(existing['workspace_id']),
            runId: String(clar.run_id),
            answer: {
              messageId: storedId,
              clarificationId,
              authorUserId: String(existing['user_id']),
              text,
            },
          }).catch(() => ({ resumed: false }));
        }
      }
    }
    return {
      status: mapStoredTelegramStatus(String(existing['status'] ?? ''), parseStoredTelegramResult(existing['raw_payload'])),
      ...(matches ? {} : { reason: 'Duplicate delivery with different content; the original stands' }),
      message_in_id: storedId,
      ...(runId ? { run_id: runId } : {}),
      workspace_id: existing['workspace_id'] ? String(existing['workspace_id']) : undefined,
      user_id: existing['user_id'] ? String(existing['user_id']) : undefined,
    };
  }

  // 2. Command handling (/start and /start <code>)
  // Commands are administrative signals, never conversational text turns.
  // They are handled before any conversation routing or chat message creation,
  // regardless of whether the Telegram account is already linked or unlinked.
  if (normalized.kind === 'start_command') {
    if (normalized.startCode) {
      const codeHash = await sha256(normalized.startCode);
      const linkCode = await db
        .prepare(
          `SELECT id, user_id, requested_workspace_id, expires_at, consumed_at
           FROM link_codes WHERE code_hash = ?`
        )
        .bind(codeHash)
        .first<Record<string, unknown>>();

      if (!linkCode || linkCode['consumed_at'] || String(linkCode['expires_at']) <= now) {
        return await replyTelegramAdmin(db, {
          workspaceId: null,
          userId: null,
          chatId: null,
          storeStatus: 'unrouted',
          errorMessage: 'Invalid or expired link code',
          botInstallationId: normalized.botInstallationId,
          telegramUserId: normalized.telegramUserId,
          telegramChatId: normalized.telegramChatId,
          externalId: normalized.externalId,
          fingerprint,
          persistedPayload,
          now,
          text: 'That link expired. Return to Otis and tap Connect Telegram again.',
          resultStatus: 'unrouted',
          reason: 'Invalid or expired link code',
        }, options);
      }

      const userId = String(linkCode['user_id']);
      const requestedWorkspaceId = linkCode['requested_workspace_id']
        ? String(linkCode['requested_workspace_id'])
        : null;

      // Conflicting identity: this Telegram account already belongs to a
      // different Otis user. No silent reassignment, no code consumption.
      const conflictingBinding = await db
        .prepare(`SELECT user_id FROM telegram_users WHERE telegram_user_id = ?`)
        .bind(normalized.telegramUserId)
        .first<{ user_id: string }>();
      if (conflictingBinding && String(conflictingBinding.user_id) !== userId) {
        return await replyTelegramAdmin(db, {
          workspaceId: null,
          userId: null,
          chatId: null,
          storeStatus: 'unrouted',
          errorMessage: 'Conflicting Telegram identity binding',
          botInstallationId: normalized.botInstallationId,
          telegramUserId: normalized.telegramUserId,
          telegramChatId: normalized.telegramChatId,
          externalId: normalized.externalId,
          fingerprint,
          persistedPayload,
          now,
          text: 'This Telegram account is connected to another Otis account. Disconnect it there first, then try again.',
          resultStatus: 'conflict',
          reason: 'Conflicting Telegram identity binding',
        }, options);
      }

      // Resolve the exact workspace: requested intent wins when still valid;
      // legacy codes without intent keep single-auto-select semantics.
      let workspaceId: string | null = null;
      if (requestedWorkspaceId) {
        const stillMember = await db
          .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
          .bind(requestedWorkspaceId, userId)
          .first();
        if (!stillMember) {
          return await replyTelegramAdmin(db, {
            workspaceId: null,
            userId,
            chatId: null,
            storeStatus: 'unrouted',
            errorMessage: 'Requested workspace no longer available',
            botInstallationId: normalized.botInstallationId,
            telegramUserId: normalized.telegramUserId,
            telegramChatId: normalized.telegramChatId,
            externalId: normalized.externalId,
            fingerprint,
            persistedPayload,
            now,
            text: 'That workspace is no longer available. Reopen Otis and connect again.',
            resultStatus: 'unrouted',
            reason: 'Requested workspace no longer available',
          }, options);
        }
        workspaceId = requestedWorkspaceId;
      } else {
        // Find user's active workspace memberships
        const memberships = (await db
          .prepare(
            `SELECT workspace_id FROM workspace_users WHERE user_id = ?`
          )
          .bind(userId)
          .all<{ workspace_id: string }>()).results || [];

        // Exactly one membership auto-selects; ambiguous identities stay unrouted
        workspaceId = memberships.length === 1 ? memberships[0]!.workspace_id : null;
      }

      // Atomically consume link code and link Telegram account using guarded link_redemptions
      const confirmationId = `min_${crypto.randomUUID()}`;
      try {
        // The confirmation copy needs a resolved workspace; legacy
        // multi-membership links without one resolve selection via /workspace.
        const confirmation = workspaceId ? await telegramConfirmationCopy(db, userId, workspaceId) : null;
        await db.batch([
          // Committing guard for the two identity predicates: a binding that
          // already belongs to a different Otis user, or a requested
          // workspace whose membership was revoked after the prechecks, must
          // abort this whole redemption (code unconsumed, nothing replaced).
          db
            .prepare(
              `INSERT INTO acceptance_guards (id, guard_ok)
               VALUES (
                 ?,
                 (SELECT 1
                  WHERE NOT EXISTS (
                    SELECT 1 FROM telegram_users WHERE telegram_user_id = ? AND user_id <> ?
                  )
                    AND (? IS NULL OR EXISTS (
                      SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?
                    )))
               )
               ON CONFLICT(id) DO UPDATE SET guard_ok = excluded.guard_ok`,
            )
            .bind(
              `guard_tg_redeem_${userId}`,
              normalized.telegramUserId,
              userId,
              workspaceId,
              workspaceId,
              userId,
            ),

          db
            .prepare(
              `INSERT INTO link_redemptions (link_code_id, telegram_user_id, redeemed_at, guard_ok)
               VALUES (?, ?, ?, (SELECT 1 FROM link_codes WHERE id = ? AND consumed_at IS NULL AND expires_at > ?))`
            )
            .bind(String(linkCode['id']), normalized.telegramUserId, now, String(linkCode['id']), now),

          db
            .prepare(`UPDATE link_codes SET consumed_at = ? WHERE id = ?`)
            .bind(now, String(linkCode['id'])),

          db
            .prepare(
              `INSERT INTO telegram_users (telegram_user_id, user_id, selected_workspace_id, active_chat_id, created_at, updated_at)
               VALUES (?, ?, ?, NULL, ?, ?)
               ON CONFLICT(telegram_user_id) DO UPDATE SET
                 user_id = excluded.user_id,
                 selected_workspace_id = excluded.selected_workspace_id,
                 active_chat_id = NULL,
                 updated_at = excluded.updated_at
               WHERE telegram_users.user_id = excluded.user_id`
            )
            .bind(normalized.telegramUserId, userId, workspaceId, now, now),

          db
            .prepare(
              `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, created_at, updated_at)
               VALUES (?, ?, ?, 'telegram', ?, ?, ?, 'processed', NULL, NULL, ?, ?)`
            )
            .bind(
              confirmationId,
              workspaceId,
              userId,
              normalized.externalId,
              fingerprint,
              wrapPersistedPayload(persistedPayload, { result: 'linked' }),
              now,
              now,
            ),

          // The redemption confirmation goes out as an administrative
          // delivery in the same commit. Routing is supplied explicitly:
          // the rows above do not exist yet for the builder to resolve.
          ...(confirmation && workspaceId
            ? await buildTelegramDeliveryInserts(db, {
              workspaceId,
              userId,
              chatId: '',
              sourceMessageId: confirmationId,
              runId: null,
              kind: 'admin',
              key: confirmationId,
              text: confirmation,
              target: {
                botInstallationId: normalized.botInstallationId,
                telegramUserId: normalized.telegramUserId,
                telegramChatId: normalized.telegramChatId,
              },
            })
            : []),
        ]);

        return {
          status: 'linked',
          user_id: userId,
          workspace_id: workspaceId || undefined,
        };
      } catch (err) {
          // Check if failure was a verified guard / race failure (code expired, consumed, or already redeemed)
          const codeCheck = await db
            .prepare(`SELECT id, consumed_at, expires_at FROM link_codes WHERE id = ?`)
            .bind(String(linkCode['id']))
            .first<Record<string, unknown>>();
          const redemptionCheck = await db
            .prepare(`SELECT 1 FROM link_redemptions WHERE link_code_id = ?`)
            .bind(String(linkCode['id']))
            .first();

          const isGuardFailure =
            !codeCheck ||
            codeCheck['consumed_at'] !== null ||
            String(codeCheck['expires_at']) <= now ||
            Boolean(redemptionCheck);

          if (isGuardFailure) {
            const minId = `min_${crypto.randomUUID()}`;
            await db
              .prepare(
                `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, error_message, created_at, updated_at)
                 VALUES (?, NULL, NULL, 'telegram', ?, ?, ?, 'unrouted', NULL, NULL, 'Invalid or expired link code', ?, ?)`
              )
              .bind(minId, normalized.externalId, fingerprint, persistedPayload, now, now)
              .run();

            return {
              status: 'unrouted',
              reason: 'Invalid or expired link code',
              message_in_id: minId,
            };
          }

          // Committing-guard race: the identity predicates are re-checked
          // here so a conflicting binding or revoked requested membership is
          // reported truthfully with the code unconsumed, never as a 500.
          const bindingNow = await db
            .prepare(`SELECT user_id FROM telegram_users WHERE telegram_user_id = ?`)
            .bind(normalized.telegramUserId)
            .first<{ user_id: string }>();
          if (bindingNow && String(bindingNow.user_id) !== userId) {
            return await replyTelegramAdmin(db, {
              workspaceId: null,
              userId: null,
              chatId: null,
              storeStatus: 'unrouted',
              errorMessage: 'Conflicting Telegram identity binding',
              botInstallationId: normalized.botInstallationId,
              telegramUserId: normalized.telegramUserId,
              telegramChatId: normalized.telegramChatId,
              externalId: normalized.externalId,
              fingerprint,
              persistedPayload,
              now,
              text: 'This Telegram account is connected to another Otis account. Disconnect it there first, then try again.',
              resultStatus: 'conflict',
              reason: 'Conflicting Telegram identity binding',
            }, options);
          }
          if (requestedWorkspaceId) {
            const memberNow = await db
              .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
              .bind(requestedWorkspaceId, userId)
              .first();
            if (!memberNow) {
              return await replyTelegramAdmin(db, {
                workspaceId: null,
                userId,
                chatId: null,
                storeStatus: 'unrouted',
                errorMessage: 'Requested workspace no longer available',
                botInstallationId: normalized.botInstallationId,
                telegramUserId: normalized.telegramUserId,
                telegramChatId: normalized.telegramChatId,
                externalId: normalized.externalId,
                fingerprint,
                persistedPayload,
                now,
                text: 'That workspace is no longer available. Reopen Otis and connect again.',
                resultStatus: 'unrouted',
                reason: 'Requested workspace no longer available',
              }, options);
            }
          }

          // Not a verified guard failure: D1/storage failure! Propagate so webhook returns 500 for retry.
          throw err;
        }
      }

    // Bare /start without a code: check if account is already linked
    const existingLink = await db
      .prepare(
        `SELECT telegram_user_id, user_id, selected_workspace_id
         FROM telegram_users WHERE telegram_user_id = ?`
      )
      .bind(normalized.telegramUserId)
      .first<Record<string, unknown>>();

    if (existingLink) {
      const minId = `min_${crypto.randomUUID()}`;
      const linkedUserId = String(existingLink['user_id']);
      const linkedWorkspaceId = existingLink['selected_workspace_id']
        ? String(existingLink['selected_workspace_id'])
        : null;
      await db
        .prepare(
          `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, created_at, updated_at)
           VALUES (?, ?, ?, 'telegram', ?, ?, ?, 'processed', NULL, NULL, ?, ?)`
        )
        .bind(
          minId,
          linkedWorkspaceId,
          linkedUserId,
          normalized.externalId,
          fingerprint,
          wrapPersistedPayload(persistedPayload, { result: 'ignored' }),
          now,
          now,
        )
        .run();

      // Repeat /start on an already-linked account: same concise
      // confirmation, idempotent by delivery key (no rebinding, no flood).
      if (linkedWorkspaceId) {
        const confirmation = await telegramConfirmationCopy(db, linkedUserId, linkedWorkspaceId);
        await db.batch(
          await buildTelegramDeliveryInserts(db, {
            workspaceId: linkedWorkspaceId,
            userId: linkedUserId,
            chatId: '',
            sourceMessageId: minId,
            runId: null,
            kind: 'admin',
            key: minId,
            text: confirmation,
            target: {
              botInstallationId: normalized.botInstallationId,
              telegramUserId: normalized.telegramUserId,
              telegramChatId: normalized.telegramChatId,
            },
          }),
        );
      }

      return {
        status: 'ignored',
        reason: 'Already linked Telegram account',
        message_in_id: minId,
        user_id: linkedUserId,
        workspace_id: linkedWorkspaceId ?? undefined,
      };
    }

    // Bare /start from an unlinked account
    const minId = `min_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, error_message, created_at, updated_at)
         VALUES (?, NULL, NULL, 'telegram', ?, ?, ?, 'unrouted', NULL, NULL, 'Unlinked Telegram account', ?, ?)`
      )
      .bind(minId, normalized.externalId, fingerprint, persistedPayload, now, now)
      .run();

    return {
      status: 'unrouted',
      reason: 'Unlinked Telegram account',
      message_in_id: minId,
    };
  }

  // 3. Resolve linked Otis user for conversational messages
  const linkRow = await db
    .prepare(
      `SELECT telegram_user_id, user_id, selected_workspace_id, active_chat_id
       FROM telegram_users WHERE telegram_user_id = ?`
    )
    .bind(normalized.telegramUserId)
    .first<Record<string, unknown>>();

  // Handle unlinked Telegram users sending ordinary conversational messages
  if (!linkRow) {
    const minId = `min_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, error_message, created_at, updated_at)
         VALUES (?, NULL, NULL, 'telegram', ?, ?, ?, 'unrouted', NULL, NULL, 'Unlinked Telegram account', ?, ?)`
      )
      .bind(minId, normalized.externalId, fingerprint, persistedPayload, now, now)
      .run();

    return {
      status: 'unrouted',
      reason: 'Unlinked Telegram account',
      message_in_id: minId,
    };
  }

  // Linked Telegram user
  const userId = String(linkRow['user_id']);
  let workspaceId = linkRow['selected_workspace_id']
    ? String(linkRow['selected_workspace_id'])
    : null;

  // Re-check live membership in selected_workspace_id
  if (workspaceId) {
    const isMember = await db
      .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .bind(workspaceId, userId)
      .first();

    if (!isMember) {
      workspaceId = null;
    }
  }

  // If no valid selected workspace, check user's memberships
  if (!workspaceId) {
    const memberships = (await db
      .prepare(
        `SELECT workspace_id FROM workspace_users WHERE user_id = ?`
      )
      .bind(userId)
      .all<{ workspace_id: string }>()).results || [];

    if (memberships.length === 1) {
      // Exactly one membership: unambiguous auto-selection
      workspaceId = memberships[0]!.workspace_id;
      await db
        .prepare(
          `UPDATE telegram_users SET selected_workspace_id = ?, active_chat_id = NULL, updated_at = ? WHERE telegram_user_id = ?`
        )
        .bind(workspaceId, now, normalized.telegramUserId)
        .run();
    } else if (memberships.length > 1) {
      // Ambiguous multiple memberships: do NOT guess, stay unrouted
      await db
        .prepare(
          `UPDATE telegram_users SET selected_workspace_id = NULL, active_chat_id = NULL, updated_at = ? WHERE telegram_user_id = ?`
        )
        .bind(now, normalized.telegramUserId)
        .run();

      const minId = `min_${crypto.randomUUID()}`;
      await db
        .prepare(
          `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, error_message, created_at, updated_at)
           VALUES (?, NULL, ?, 'telegram', ?, ?, ?, 'unrouted', NULL, NULL, 'Multiple workspaces available; please select a workspace first', ?, ?)`
        )
        .bind(minId, userId, normalized.externalId, fingerprint, persistedPayload, now, now)
        .run();

      return {
        status: 'unrouted',
        reason: 'Multiple workspaces available; please select a workspace first',
        message_in_id: minId,
        user_id: userId,
      };
    } else {
      // 0 memberships
      await db
        .prepare(
          `UPDATE telegram_users SET selected_workspace_id = NULL, active_chat_id = NULL, updated_at = ? WHERE telegram_user_id = ?`
        )
        .bind(now, normalized.telegramUserId)
        .run();
    }
  }

  if (!workspaceId) {
    // No workspace resolved: only /workspace listing/selection can run
    // here. Anything else falls through to the unrouted guidance below.
    if (normalized.kind === 'text' && normalized.text) {
      const pre = parseCommandText(normalized.text, 'telegram', options?.botUsername);
      if (pre.kind === 'command' && pre.name === 'workspace') {
        const outcome = await executeTelegramCommand(db, {
          workspaceId: null,
          userId,
          telegramUserId: normalized.telegramUserId,
          telegramChatId: normalized.telegramChatId,
          botInstallationId: normalized.botInstallationId,
          chatId: null,
          sourceMessageId: `min_${crypto.randomUUID()}`,
          externalId: normalized.externalId,
          fingerprint,
          persistedPayload,
          clientOperationId: `tg:${normalized.externalId}`,
          text: normalized.text,
          botUsername: options?.botUsername,
          nowIso: now,
          requestId: 'telegram-preselection',
        });
        if (outcome.handled && outcome.workspaceId) {
          // Selection adopted: persist and deliver the confirmation through
          // the same administrative-reply path, so redelivery stays a
          // no-op and the reply is not silently dropped.
          return await replyTelegramAdmin(db, {
            workspaceId: outcome.workspaceId,
            userId,
            chatId: null,
            storeStatus: 'processed',
            botInstallationId: normalized.botInstallationId,
            telegramUserId: normalized.telegramUserId,
            telegramChatId: normalized.telegramChatId,
            externalId: normalized.externalId,
            fingerprint,
            persistedPayload,
            now,
            text: outcome.reply ?? 'Workspace selected for Telegram.',
            resultStatus: 'accepted',
            reason: 'Workspace selected',
          }, options);
        }
        if (outcome.handled) {
          return await replyTelegramAdmin(db, {
            workspaceId: null,
            userId,
            chatId: null,
            storeStatus: 'unrouted',
            botInstallationId: normalized.botInstallationId,
            telegramUserId: normalized.telegramUserId,
            telegramChatId: normalized.telegramChatId,
            externalId: normalized.externalId,
            fingerprint,
            persistedPayload,
            now,
            text: outcome.reply ?? 'Which workspace should Telegram use?',
            resultStatus: 'unrouted',
            reason: 'Workspace selection needed',
          }, options);
        }
      }
    }
    const minId = `min_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, error_message, created_at, updated_at)
         VALUES (?, NULL, ?, 'telegram', ?, ?, ?, 'unrouted', NULL, NULL, 'User is not an active member of any workspace', ?, ?)`
      )
      .bind(minId, userId, normalized.externalId, fingerprint, persistedPayload, now, now)
      .run();

    return {
      status: 'unrouted',
      reason: 'User is not an active member of any workspace',
      message_in_id: minId,
      user_id: userId,
    };
  }

  // Ensure active chat exists and belongs to this author in this workspace
  let chatId = linkRow['active_chat_id'] ? String(linkRow['active_chat_id']) : null;
  if (chatId) {
    const validChat = await db
      .prepare(`SELECT 1 FROM chats WHERE id = ? AND workspace_id = ? AND author_user_id = ?`)
      .bind(chatId, workspaceId, userId)
      .first();
    if (!validChat) {
      chatId = null;
    }
  }

  const dynamicTopic = normalized.kind === 'text' && normalized.text
    ? generateChatTitle(normalized.text)
    : normalized.kind === 'voice'
    ? 'Voice Note'
    : null;
  const initialTitle = dynamicTopic && dynamicTopic !== 'New conversation'
    ? `Telegram · ${dynamicTopic}`
    : 'Telegram';

  if (!chatId) {
    const chat = await createChat(db, {
      workspaceId,
      authorUserId: userId,
      title: initialTitle,
    });
    chatId = chat.id;
    await db
      .prepare(
        `UPDATE telegram_users SET active_chat_id = ?, updated_at = ? WHERE telegram_user_id = ?`
      )
      .bind(chatId, now, normalized.telegramUserId)
      .run();
  } else if (normalized.kind === 'text' && normalized.text) {
    const existing = await db
      .prepare(`SELECT title FROM chats WHERE id = ? AND workspace_id = ?`)
      .bind(chatId, workspaceId)
      .first<{ title: string }>();
    const isGeneric = !existing?.title ||
      existing.title === 'Telegram' ||
      existing.title === 'Telegram · Voice Note' ||
      existing.title === 'Telegram Conversation' ||
      existing.title === 'New conversation' ||
      existing.title === 'Untitled conversation';
    if (isGeneric) {
      try {
        const topic = generateChatTitle(normalized.text);
        if (topic && topic !== 'New conversation') {
          await updateChatTitle(db, {
            workspaceId,
            chatId,
            userId,
            title: `Telegram · ${topic}`,
          });
        }
      } catch {
        // Non-fatal title update
      }
    }
  }

  // 2b. Slash commands run through the shared interpreter with the
  // configured bot username — never through the model. A command takes
  // precedence over reply targeting.
  if (normalized.kind === 'text' && normalized.text) {
    const parsed = parseCommandText(normalized.text, 'telegram', options?.botUsername);
    if (parsed.kind !== 'text') {
      const outcome = await executeTelegramCommand(db, {
        workspaceId,
        userId,
        telegramUserId: normalized.telegramUserId,
        telegramChatId: normalized.telegramChatId,
        botInstallationId: normalized.botInstallationId,
        chatId,
        sourceMessageId: `min_${crypto.randomUUID()}`,
        externalId: normalized.externalId,
        fingerprint,
        persistedPayload,
        clientOperationId: `tg:${normalized.externalId}`,
        text: normalized.text,
        botUsername: options?.botUsername,
        platformKeys: options?.platformKeys,
        nowIso: now,
        requestId: 'telegram-command',
      });
      if (outcome.handled) {
        return {
          status: 'accepted',
          message_in_id: undefined,
          workspace_id: outcome.workspaceId ?? workspaceId,
          user_id: userId,
        };
      }
    }
  }

  // 2c. Native replies target a delivered bot question exactly: map the
  // external bot message ID through this identity/workspace's delivered
  // question delivery to its clarification ID. Anything else falls through
  // to ordinary acceptance below — never silently routed.
  if (normalized.kind === 'text' && normalized.text && normalized.replyToMessageId) {
    const targeted = await acceptTelegramReply(db, {
      workspaceId,
      userId,
      telegramUserId: normalized.telegramUserId,
      telegramChatId: normalized.telegramChatId,
      botInstallationId: normalized.botInstallationId,
      chatId,
      externalId: normalized.externalId,
      fingerprint,
      persistedPayload,
      text: normalized.text,
      replyToMessageId: normalized.replyToMessageId,
      now,
    });
    if (targeted) return targeted;
  }

  // 3. Handle Media Rules
  if (normalized.kind === 'voice') {
    const metadata = extractTelegramVoiceMetadata(normalized.rawUpdate);
    // Voice ingest requires a private storage binding and an explicit file
    // transport. Tests without an injected transport keep the honest
    // unsupported row and never dial Telegram.
    if (metadata && options?.storage && options.botToken && options.fileTransport) {
      try {
        const accepted = await acceptTelegramVoiceMessage({
          db,
          storage: options.storage,
          workspaceId,
          userId,
          chatId,
          botToken: options.botToken,
          externalId: normalized.externalId,
          fingerprint,
          persistedPayload,
          telegramMessageId: normalized.telegramMessageId,
          metadata,
          nowIso: now,
          fetchFn: options.fileTransport,
          platformKeys: options.platformKeys,
        });
        return {
          status: 'accepted',
          message_in_id: accepted.messageInId,
          run_id: accepted.runId,
          workspace_id: workspaceId,
          user_id: userId,
        };
      } catch (err) {
        const code = err instanceof TelegramVoiceError ? err.code : 'transport_failed';
        const message = err instanceof TelegramVoiceError
          ? err.message
          : 'The voice note could not be processed.';
        if (options?.adminTransport && options?.botToken) {
          return await replyTelegramAdmin(db, {
            workspaceId,
            userId,
            chatId,
            storeStatus: 'processed',
            errorMessage: `Voice note rejected (${code}): ${message}`,
            botInstallationId: normalized.botInstallationId,
            telegramUserId: normalized.telegramUserId,
            telegramChatId: normalized.telegramChatId,
            externalId: normalized.externalId,
            fingerprint,
            persistedPayload,
            now,
            text: `I couldn't process your voice note: ${message}`,
            resultStatus: 'unsupported',
            reason: message,
          }, options);
        }
        const minId = `min_${crypto.randomUUID()}`;
        await db
          .prepare(
            `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, error_message, created_at, updated_at)
             VALUES (?, ?, ?, 'telegram', ?, ?, ?, 'unsupported', NULL, ?, ?, ?, ?)`,
          )
          .bind(
            minId,
            workspaceId,
            userId,
            normalized.externalId,
            fingerprint,
            persistedPayload,
            chatId,
            `Voice note rejected (${code}): ${message}`,
            now,
            now,
          )
          .run();
        return {
          status: 'unsupported',
          reason: message,
          message_in_id: minId,
          workspace_id: workspaceId,
          user_id: userId,
        };
      }
    }

    if (options?.adminTransport && options?.botToken) {
      return await replyTelegramAdmin(db, {
        workspaceId,
        userId,
        chatId,
        storeStatus: 'processed',
        errorMessage: 'Voice notes are unavailable in this environment',
        botInstallationId: normalized.botInstallationId,
        telegramUserId: normalized.telegramUserId,
        telegramChatId: normalized.telegramChatId,
        externalId: normalized.externalId,
        fingerprint,
        persistedPayload,
        now,
        text: 'Voice notes are currently unavailable. Please type your message.',
        resultStatus: 'unsupported',
        reason: 'Voice notes are unavailable',
      }, options);
    }

    const minId = `min_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, error_message, created_at, updated_at)
         VALUES (?, ?, ?, 'telegram', ?, ?, ?, 'unsupported', NULL, ?, 'Voice notes are pending voice gate implementation (Gate 010)', ?, ?)`
      )
      .bind(
        minId,
        workspaceId,
        userId,
        normalized.externalId,
        fingerprint,
        persistedPayload,
        chatId,
        now,
        now,
      )
      .run();

    return {
      status: 'unsupported',
      reason: 'Voice notes are pending voice gate implementation (Gate 010)',
      message_in_id: minId,
      workspace_id: workspaceId,
      user_id: userId,
    };
  }

  if (normalized.kind === 'unsupported_media_only') {
    const minId = `min_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, error_message, created_at, updated_at)
         VALUES (?, ?, ?, 'telegram', ?, ?, ?, 'unsupported', NULL, ?, 'Unsupported media only (metadata retained)', ?, ?)`
      )
      .bind(
        minId,
        workspaceId,
        userId,
        normalized.externalId,
        fingerprint,
        JSON.stringify({ unsupported_types: normalized.unsupportedMediaTypes }),
        chatId,
        now,
        now,
      )
      .run();

    return {
      status: 'unsupported',
      reason: 'Unsupported media only',
      message_in_id: minId,
      workspace_id: workspaceId,
      user_id: userId,
    };
  }

  if (normalized.kind === 'unsupported_media_with_text') {
    // "Attached text needs explicit text-only confirmation; no partial silent processing."
    const minId = `min_${crypto.randomUUID()}`;
    const clarId = `clar_${crypto.randomUUID()}`;
    const runId = `run_${crypto.randomUUID()}`;

    // Get current business revision
    const wsRow = await db
      .prepare(`SELECT business_revision FROM workspaces WHERE id = ?`)
      .bind(workspaceId)
      .first<{ business_revision: number }>();
    const sourceRevision = wsRow ? wsRow.business_revision : 0;

    await db.batch([
      db
        .prepare(
          `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, error_message, created_at, updated_at)
           VALUES (?, ?, ?, 'telegram', ?, ?, ?, 'waiting_for_input', NULL, ?, 'Confirmation required for text attached to unsupported media', ?, ?)`
        )
        .bind(
          minId,
          workspaceId,
          userId,
          normalized.externalId,
          fingerprint,
          persistedPayload,
          chatId,
          now,
          now,
        ),

      db
        .prepare(
          `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, source_job_id, executor_kind, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, 'agent', 'waiting_for_input', ?, ?)`
        )
        .bind(runId, workspaceId, chatId, minId, now, now),

      db
        .prepare(
          `INSERT INTO pending_clarifications (id, workspace_id, chat_id, run_id, source_message_id, requester_user_id, question, intended_operation, missing_fields, candidates_json, source_revision, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'process_text_only', '[]', ?, ?, 'pending', ?, ?)`
        )
        .bind(
          clarId,
          workspaceId,
          chatId,
          runId,
          minId,
          userId,
          `Received media with text "${normalized.text}". Process text only?`,
          JSON.stringify({ text: normalized.text, media_types: normalized.unsupportedMediaTypes }),
          sourceRevision,
          now,
          now,
        ),
    ]);

    return {
      status: 'confirmation_required',
      reason: 'Attached text needs explicit confirmation',
      message_in_id: minId,
      run_id: runId,
      workspace_id: workspaceId,
      user_id: userId,
    };
  }

  // Reject empty text message
  if (!normalized.text || normalized.text.trim().length === 0) {
    return {
      status: 'ignored',
      reason: 'Empty message text',
    };
  }

  // 4. Clean text message: Durable Acceptance into Workspace & Chat.
  // Concurrent duplicate delivery of the same update races here: a UNIQUE
  // violation rereads and verifies the persisted record instead of failing.
  try {
    const accepted = await acceptTelegramTextMessage(db, {
      workspaceId,
      userId,
      chatId,
      externalId: normalized.externalId,
      fingerprint,
      persistedPayload,
      text: normalized.text!,
      now,
    });
    return {
      status: 'accepted',
      message_in_id: accepted.messageInId,
      run_id: accepted.runId,
      workspace_id: workspaceId,
      user_id: userId,
    };
  } catch (err) {
    // Concurrent duplicate delivery of the same update: reread and verify
    // the persisted record instead of failing indefinitely. Anything else
    // falls through to revocation analysis below.
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      const raced = await db
        .prepare(`SELECT id, workspace_id, user_id, chat_id, payload_fingerprint FROM messages_in WHERE channel = 'telegram' AND external_id = ?`)
        .bind(normalized.externalId)
        .first<Record<string, unknown>>();
      if (
        raced &&
        raced['workspace_id'] === workspaceId &&
        raced['user_id'] === userId &&
        raced['chat_id'] === chatId &&
        raced['payload_fingerprint'] === fingerprint
      ) {
        const storedId = String(raced['id']);
        const run = await db
          .prepare(`SELECT id FROM agent_runs WHERE source_message_id = ? ORDER BY created_at DESC LIMIT 1`)
          .bind(storedId)
          .first<{ id: string }>();
        return {
          status: 'accepted',
          message_in_id: storedId,
          ...(run ? { run_id: run.id } : {}),
          workspace_id: workspaceId,
          user_id: userId,
        };
      }
    }
    // Only a verified membership or chat ownership revocation should become unrouted!
    const isMember = await db
      .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .bind(workspaceId, userId)
      .first();
    const currentChat = chatId
      ? await db
          .prepare(`SELECT 1 FROM chats WHERE id = ? AND workspace_id = ? AND author_user_id = ?`)
          .bind(chatId, workspaceId, userId)
          .first()
      : null;

    if (!isMember || !currentChat) {
      // Transaction guard failure is verified!
      const minId = `min_${crypto.randomUUID()}`;
      await db
        .prepare(
          `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, error_message, created_at, updated_at)
           VALUES (?, ?, ?, 'telegram', ?, ?, ?, 'unrouted', NULL, ?, 'Membership or authorship verification failed', ?, ?)`
        )
        .bind(minId, workspaceId, userId, normalized.externalId, fingerprint, persistedPayload, chatId, now, now)
        .run();

      return {
        status: 'unrouted',
        reason: 'Membership or authorship verification failed',
        message_in_id: minId,
        workspace_id: workspaceId,
        user_id: userId,
      };
    }

    // Storage / database failure: rethrow so handleTelegramWebhook returns 500 and Telegram retries delivery!
    throw err;
  }
}

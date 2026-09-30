/**
 * @otis/worker/inbox/telegram
 * Telegram inbound message routing, account linking, media handling, and acceptance.
 * In accordance with docs/contracts.md and plans/004-inbound-routing.md.
 */

import {
  normalizeTelegramUpdate,
  type NormalizedTelegramUpdate,
} from '@otis/channels';
import { sha256 } from '@otis/identity';
import { createChat } from './repository.js';

export interface TelegramInboundResult {
  status:
    | 'accepted'
    | 'linked'
    | 'unrouted'
    | 'unsupported'
    | 'confirmation_required'
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
 * Accepts an incoming Telegram update.
 */
export async function acceptTelegramInbound(
  db: D1Database,
  botInstallationId: string,
  update: unknown,
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

  // Redact one-time link code from persisted raw payload to prevent plaintext credential leaks
  const persistedPayload = getPersistedPayload(update, normalized.startCode);
  const fingerprint = await sha256(persistedPayload);
  const now = new Date().toISOString();

  // 1. Check Deduplication on (channel = 'telegram', external_id)
  const existing = await db
    .prepare(
      `SELECT id, status, workspace_id, user_id FROM messages_in WHERE channel = 'telegram' AND external_id = ?`
    )
    .bind(normalized.externalId)
    .first<Record<string, unknown>>();

  if (existing) {
    return {
      status: (existing['status'] as TelegramInboundResult['status']) || 'accepted',
      message_in_id: String(existing['id']),
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
          `SELECT id, user_id, expires_at, consumed_at
           FROM link_codes WHERE code_hash = ?`
        )
        .bind(codeHash)
        .first<Record<string, unknown>>();

      if (linkCode && !linkCode['consumed_at'] && String(linkCode['expires_at']) > now) {
        const userId = String(linkCode['user_id']);

        // Find user's active workspace memberships
        const memberships = (await db
          .prepare(
            `SELECT workspace_id FROM workspace_users WHERE user_id = ?`
          )
          .bind(userId)
          .all<{ workspace_id: string }>()).results || [];

        // Exactly one membership auto-selects; ambiguous identities stay unrouted
        const workspaceId = memberships.length === 1 ? memberships[0]!.workspace_id : null;

        // Atomically consume link code and link Telegram account using guarded link_redemptions
        try {
          await db.batch([
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
                   updated_at = excluded.updated_at`
              )
              .bind(normalized.telegramUserId, userId, workspaceId, now, now),

            db
              .prepare(
                `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, created_at, updated_at)
                 VALUES (?, ?, ?, 'telegram', ?, ?, ?, 'processed', NULL, NULL, ?, ?)`
              )
              .bind(
                `min_${crypto.randomUUID()}`,
                workspaceId,
                userId,
                normalized.externalId,
                fingerprint,
                persistedPayload,
                now,
                now,
              ),
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

          // Not a verified guard failure: D1/storage failure! Propagate so webhook returns 500 for retry.
          throw err;
        }
      }

      // Invalid or expired link code
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
      await db
        .prepare(
          `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, created_at, updated_at)
           VALUES (?, ?, ?, 'telegram', ?, ?, ?, 'processed', NULL, NULL, ?, ?)`
        )
        .bind(
          minId,
          existingLink['selected_workspace_id'] ? String(existingLink['selected_workspace_id']) : null,
          String(existingLink['user_id']),
          normalized.externalId,
          fingerprint,
          persistedPayload,
          now,
          now,
        )
        .run();

      return {
        status: 'ignored',
        reason: 'Already linked Telegram account',
        message_in_id: minId,
        user_id: String(existingLink['user_id']),
        workspace_id: existingLink['selected_workspace_id'] ? String(existingLink['selected_workspace_id']) : undefined,
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

  if (!chatId) {
    const chat = await createChat(db, {
      workspaceId,
      authorUserId: userId,
      title: 'Telegram Conversation',
    });
    chatId = chat.id;
    await db
      .prepare(
        `UPDATE telegram_users SET active_chat_id = ?, updated_at = ? WHERE telegram_user_id = ?`
      )
      .bind(chatId, now, normalized.telegramUserId)
      .run();
  }

  // 3. Handle Media Rules
  if (normalized.kind === 'voice') {
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

  // 4. Clean text message: Durable Acceptance into Workspace & Chat
  const messageInId = `min_${crypto.randomUUID()}`;
  const chatMessageId = `msg_${crypto.randomUUID()}`;
  const runId = `run_${crypto.randomUUID()}`;
  const outboxId = `out_${crypto.randomUUID()}`;
  const activityId = `act_${crypto.randomUUID()}`;

  const seqRow = await db
    .prepare(`SELECT COALESCE(MAX(sequence), 0) as max_seq FROM chat_messages WHERE chat_id = ?`)
    .bind(chatId)
    .first<{ max_seq: number }>();
  const nextMsgSeq = (seqRow?.max_seq || 0) + 1;

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
           )`
        )
        .bind(
          `guard_${crypto.randomUUID()}`,
          chatId,
          workspaceId,
          userId,
        ),

      db
        .prepare(
          `UPDATE workspaces SET last_acceptance_sequence = last_acceptance_sequence + 1, updated_at = ? WHERE id = ?`
        )
        .bind(now, workspaceId),

      db
        .prepare(
          `UPDATE chats SET activity_cursor = activity_cursor + 1, last_activity_at = ?, updated_at = ? WHERE id = ?`
        )
        .bind(now, now, chatId),

      db
        .prepare(
          `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, created_at, updated_at)
           VALUES (?, ?, ?, 'telegram', ?, ?, ?, 'queued', (SELECT last_acceptance_sequence FROM workspaces WHERE id = ?), ?, ?, ?)`
        )
        .bind(
          messageInId,
          workspaceId,
          userId,
          normalized.externalId,
          fingerprint,
          persistedPayload,
          workspaceId,
          chatId,
          now,
          now,
        ),

      db
        .prepare(
          `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, source_job_id, executor_kind, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, 'agent', 'queued', ?, ?)`
        )
        .bind(runId, workspaceId, chatId, messageInId, now, now),

      db
        .prepare(
          `INSERT INTO chat_messages (id, workspace_id, chat_id, author_user_id, author_kind, channel, inbound_message_id, client_message_id, content_text, media_id, run_id, sequence, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'member', 'telegram', ?, NULL, ?, NULL, ?, ?, ?, ?)`
        )
        .bind(
          chatMessageId,
          workspaceId,
          chatId,
          userId,
          messageInId,
          normalized.text,
          runId,
          nextMsgSeq,
          now,
          now,
        ),

      db
        .prepare(
          `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
           VALUES (?, ?, ?, ?, (SELECT activity_cursor FROM chats WHERE id = ?), 'message_accepted', ?, ?)`
        )
        .bind(
          activityId,
          workspaceId,
          chatId,
          runId,
          chatId,
          JSON.stringify({ text: normalized.text, channel: 'telegram' }),
          now,
        ),

      db
        .prepare(
          `INSERT INTO outbox (id, workspace_id, destination, topic, payload_json, status, created_at, updated_at)
           VALUES (?, ?, 'workspace_actor', 'execute_run', ?, 'pending', ?, ?)`
        )
        .bind(
          outboxId,
          workspaceId,
          JSON.stringify({
            run_id: runId,
            chat_id: chatId,
            message_id: chatMessageId,
            channel: 'telegram',
          }),
          now,
          now,
        ),
    ]);

    return {
      status: 'accepted',
      message_in_id: messageInId,
      run_id: runId,
      workspace_id: workspaceId,
      user_id: userId,
    };
  } catch (err) {
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

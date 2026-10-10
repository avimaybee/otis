/**
 * Telegram callback query handling (R15 interactive buttons).
 *
 * Dispatches inline button taps:
 * - cb:undo -> executes /undo
 * - cb:model:<key> -> sets active chat model
 * - cb:thinking:<level> -> sets active chat thinking effort
 * - cb:clarify:<id>:<value> -> answers pending clarification option
 * - cb:draft:sent:<draftId> -> marks outward draft as confirmed sent
 *
 * Acknowledges queries immediately via answerCallbackQuery to dismiss client spinners.
 * Enforces authenticated link and workspace membership checks before performing mutations.
 */

import {
  executeLedgerCommand,
  getWorkspaceRevision,
  DEFAULT_COMMAND_HANDLERS,
} from '@otis/ledger';
import { resumeRun } from '../actor/dispatch.js';
import { createChat } from './repository.js';
import {
  answerCallbackQuery,
  buildTelegramDeliveryInserts,
  editTelegramMessageReplyMarkup,
  sendTelegramDocument,
  type TelegramSendFetch,
} from './telegramDelivery.js';
import {
  collectWorkspaceExportSections,
  workspaceExportToSheets,
} from '../routes/exports.js';
import { executeTelegramCommand } from './telegramCommands.js';
import type { PlatformKeys } from '../providers/service.js';

export interface TelegramCallbackInput {
  db: D1Database;
  botInstallationId: string;
  telegramUserId: string;
  telegramChatId: string;
  telegramMessageId?: string;
  callbackQueryId: string;
  callbackData?: string;
  externalId: string;
  fingerprint: string;
  persistedPayload: string;
  now: string;
  options?: {
    botUsername?: string;
    botToken?: string;
    adminTransport?: TelegramSendFetch;
    platformKeys?: PlatformKeys;
  };
}

export interface TelegramCallbackOutcome {
  status: 'accepted' | 'unrouted' | 'unsupported' | 'ignored';
  reason?: string;
  message_in_id?: string;
  run_id?: string;
  workspace_id?: string;
  user_id?: string;
}

async function readMembershipRevision(db: D1Database, workspaceId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT membership_revision FROM workspaces WHERE id = ?`)
    .bind(workspaceId)
    .first<{ membership_revision: number }>();
  return Number(row?.membership_revision ?? 0);
}

export async function handleTelegramCallbackQuery(
  input: TelegramCallbackInput,
): Promise<TelegramCallbackOutcome> {
  const { db, options, callbackQueryId, callbackData = '' } = input;
  const botToken = options?.botToken;
  const adminTransport = options?.adminTransport;

  // 1. Resolve linked Otis user identity
  const linkRow = await db
    .prepare(
      `SELECT telegram_user_id, user_id, selected_workspace_id, active_chat_id
       FROM telegram_users WHERE telegram_user_id = ?`,
    )
    .bind(input.telegramUserId)
    .first<Record<string, unknown>>();

  if (!linkRow) {
    if (botToken) {
      await answerCallbackQuery(
        botToken,
        callbackQueryId,
        'Please connect Telegram to Otis in settings first.',
        true,
        adminTransport,
      ).catch(() => null);
    }
    return {
      status: 'unrouted',
      reason: 'Unlinked Telegram account',
    };
  }

  const userId = String(linkRow['user_id']);
  let workspaceId = linkRow['selected_workspace_id']
    ? String(linkRow['selected_workspace_id'])
    : null;

  // 2. Validate active workspace membership
  if (workspaceId) {
    const isMember = await db
      .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .bind(workspaceId, userId)
      .first();
    if (!isMember) {
      workspaceId = null;
    }
  }

  if (!workspaceId) {
    const memberships = (
      await db
        .prepare(`SELECT workspace_id FROM workspace_users WHERE user_id = ?`)
        .bind(userId)
        .all<{ workspace_id: string }>()
    ).results || [];

    if (memberships.length === 1) {
      workspaceId = memberships[0]!.workspace_id;
      await db
        .prepare(
          `UPDATE telegram_users SET selected_workspace_id = ?, active_chat_id = NULL, updated_at = ? WHERE telegram_user_id = ?`,
        )
        .bind(workspaceId, input.now, input.telegramUserId)
        .run();
    } else {
      if (botToken) {
        await answerCallbackQuery(
          botToken,
          callbackQueryId,
          'Please select a workspace first using /workspace',
          true,
          adminTransport,
        ).catch(() => null);
      }
      return {
        status: 'unrouted',
        reason: 'No active workspace selected',
        user_id: userId,
      };
    }
  }

  // 3. Ensure active conversation chat exists
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
      title: 'Telegram',
    });
    chatId = chat.id;
    await db
      .prepare(
        `UPDATE telegram_users SET active_chat_id = ?, updated_at = ? WHERE telegram_user_id = ?`,
      )
      .bind(chatId, input.now, input.telegramUserId)
      .run();
  }

  // 4. Dispatch specific callback query actions
  // Action A: cb:undo
  if (callbackData === 'cb:undo') {
    if (botToken) {
      await answerCallbackQuery(botToken, callbackQueryId, 'Undoing...', false, adminTransport).catch(() => null);
    }
    const outcome = await executeTelegramCommand(db, {
      workspaceId,
      userId,
      telegramUserId: input.telegramUserId,
      telegramChatId: input.telegramChatId,
      botInstallationId: input.botInstallationId,
      chatId,
      sourceMessageId: `min_${crypto.randomUUID()}`,
      externalId: input.externalId,
      fingerprint: input.fingerprint,
      persistedPayload: input.persistedPayload,
      clientOperationId: `tg:${input.externalId}`,
      text: '/undo',
      botUsername: options?.botUsername,
      nowIso: input.now,
      requestId: 'telegram-cb-undo',
    });
    return {
      status: 'accepted',
      workspace_id: workspaceId,
      user_id: userId,
      reason: outcome.reply,
    };
  }

  // Action B: cb:model:<key>
  if (callbackData.startsWith('cb:model:')) {
    const modelKey = callbackData.slice('cb:model:'.length).trim();
    if (botToken) {
      await answerCallbackQuery(botToken, callbackQueryId, `Setting model to ${modelKey}...`, false, adminTransport).catch(() => null);
    }
    const outcome = await executeTelegramCommand(db, {
      workspaceId,
      userId,
      telegramUserId: input.telegramUserId,
      telegramChatId: input.telegramChatId,
      botInstallationId: input.botInstallationId,
      chatId,
      sourceMessageId: `min_${crypto.randomUUID()}`,
      externalId: input.externalId,
      fingerprint: input.fingerprint,
      persistedPayload: input.persistedPayload,
      clientOperationId: `tg:${input.externalId}`,
      text: `/model ${modelKey}`,
      botUsername: options?.botUsername,
      nowIso: input.now,
      requestId: 'telegram-cb-model',
    });
    return {
      status: 'accepted',
      workspace_id: workspaceId,
      user_id: userId,
      reason: outcome.reply,
    };
  }

  // Action C: cb:thinking:<level>
  if (callbackData.startsWith('cb:thinking:')) {
    const level = callbackData.slice('cb:thinking:'.length).trim();
    if (botToken) {
      await answerCallbackQuery(botToken, callbackQueryId, `Setting thinking to ${level}...`, false, adminTransport).catch(() => null);
    }
    const outcome = await executeTelegramCommand(db, {
      workspaceId,
      userId,
      telegramUserId: input.telegramUserId,
      telegramChatId: input.telegramChatId,
      botInstallationId: input.botInstallationId,
      chatId,
      sourceMessageId: `min_${crypto.randomUUID()}`,
      externalId: input.externalId,
      fingerprint: input.fingerprint,
      persistedPayload: input.persistedPayload,
      clientOperationId: `tg:${input.externalId}`,
      text: `/thinking ${level}`,
      botUsername: options?.botUsername,
      nowIso: input.now,
      requestId: 'telegram-cb-thinking',
    });
    return {
      status: 'accepted',
      workspace_id: workspaceId,
      user_id: userId,
      reason: outcome.reply,
    };
  }

  // Action D: cb:clarify:<id>:<value>
  if (callbackData.startsWith('cb:clarify:')) {
    const parts = callbackData.split(':');
    const clarificationId = parts[2] || '';
    const answerValue = parts.slice(3).join(':');

    if (!clarificationId || !answerValue) {
      if (botToken) {
        await answerCallbackQuery(botToken, callbackQueryId, 'Invalid option selection', true, adminTransport).catch(() => null);
      }
      return { status: 'ignored', reason: 'Invalid clarification callback data' };
    }

    const clar = await db
      .prepare(
        `SELECT id, chat_id, run_id, requester_user_id, status FROM pending_clarifications
         WHERE id = ? AND workspace_id = ?`,
      )
      .bind(clarificationId, workspaceId)
      .first<{ id: string; chat_id: string | null; run_id: string | null; requester_user_id: string | null; status: string }>();

    if (!clar || clar.status !== 'pending' || !clar.run_id) {
      if (botToken) {
        await answerCallbackQuery(botToken, callbackQueryId, 'This question was already answered or expired.', true, adminTransport).catch(() => null);
      }
      return { status: 'ignored', reason: 'Clarification no longer pending' };
    }

    const runRow = await db
      .prepare(`SELECT status FROM agent_runs WHERE id = ? AND workspace_id = ?`)
      .bind(clar.run_id, workspaceId)
      .first<{ status: string }>();

    if (!runRow || runRow.status !== 'waiting_for_input') {
      if (botToken) {
        await answerCallbackQuery(botToken, callbackQueryId, 'This question is no longer awaiting input.', true, adminTransport).catch(() => null);
      }
      return { status: 'ignored', reason: 'Run not waiting for input' };
    }

    const minId = `min_${crypto.randomUUID()}`;
    const envelope = JSON.stringify({
      update: JSON.parse(input.persistedPayload),
      telegram: { result: 'accepted', callback_query_id: callbackQueryId, clarification_id: clarificationId, text: answerValue },
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
          .bind(`guard_tg_accept_${workspaceId}`, chatId, workspaceId, userId),
        db
          .prepare(
            `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, created_at, updated_at)
             VALUES (?, ?, ?, 'telegram', ?, ?, ?, 'processed', NULL, ?, ?, ?)`,
          )
          .bind(
            minId, workspaceId, userId, input.externalId, input.fingerprint, envelope,
            chatId, input.now, input.now,
          ),
        db
          .prepare(
            `INSERT INTO chat_messages (id, workspace_id, chat_id, author_user_id, author_kind, channel, inbound_message_id, client_message_id, content_text, media_id, run_id, sequence, created_at, updated_at)
             SELECT ?, ?, ?, ?, 'member', 'telegram', ?, NULL, ?, NULL, ?, COALESCE(MAX(sequence), 0) + 1, ?, ? FROM chat_messages WHERE chat_id = ?`,
          )
          .bind(
            `msg_${crypto.randomUUID()}`, workspaceId, chatId, userId, minId,
            answerValue, clar.run_id, input.now, input.now, chatId,
          ),
        db
          .prepare(`UPDATE chats SET activity_cursor = activity_cursor + 1, last_activity_at = ?, updated_at = ? WHERE id = ?`)
          .bind(input.now, input.now, chatId),
        db
          .prepare(
            `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
             SELECT ?, ?, ?, ?, activity_cursor, 'message_accepted', ?, ? FROM chats WHERE id = ?`,
          )
          .bind(
            `act_${crypto.randomUUID()}`, workspaceId, chatId, clar.run_id,
            JSON.stringify({ text: answerValue, channel: 'telegram', clarification_id: clarificationId }), input.now, chatId,
          ),
      ]);
    } catch {
      return { status: 'ignored', reason: 'Failed to record clarification acceptance' };
    }

    if (botToken) {
      await answerCallbackQuery(botToken, callbackQueryId, `Selected: ${answerValue}`, false, adminTransport).catch(() => null);
      if (input.telegramMessageId) {
        await editTelegramMessageReplyMarkup(botToken, input.telegramChatId, input.telegramMessageId, { inline_keyboard: [] }, adminTransport).catch(() => null);
      }
    }

    await resumeRun(db, {
      workspaceId,
      runId: clar.run_id,
      answer: { messageId: minId, clarificationId, authorUserId: userId, text: answerValue },
    }).catch(() => ({ resumed: false }));

    return {
      status: 'accepted',
      message_in_id: minId,
      run_id: clar.run_id,
      workspace_id: workspaceId,
      user_id: userId,
    };
  }

  // Action E: cb:draft:sent:<draftId>
  if (callbackData.startsWith('cb:draft:sent:')) {
    const draftId = callbackData.slice('cb:draft:sent:'.length).trim();
    if (!draftId) {
      if (botToken) {
        await answerCallbackQuery(botToken, callbackQueryId, 'Invalid draft ID', true, adminTransport).catch(() => null);
      }
      return { status: 'ignored', reason: 'Missing draft ID' };
    }

    const draft = await db
      .prepare(`SELECT id, status FROM draft_projections WHERE id = ? AND workspace_id = ?`)
      .bind(draftId, workspaceId)
      .first<{ id: string; status: string }>();

    if (!draft) {
      if (botToken) {
        await answerCallbackQuery(botToken, callbackQueryId, 'Draft not found', true, adminTransport).catch(() => null);
      }
      return { status: 'ignored', reason: 'Draft not found' };
    }

    if (draft.status === 'member_confirmed_sent') {
      if (botToken) {
        await answerCallbackQuery(botToken, callbackQueryId, 'Draft is already marked as sent.', false, adminTransport).catch(() => null);
        if (input.telegramMessageId) {
          await editTelegramMessageReplyMarkup(botToken, input.telegramChatId, input.telegramMessageId, { inline_keyboard: [] }, adminTransport).catch(() => null);
        }
      }
      return {
        status: 'accepted',
        workspace_id: workspaceId,
        user_id: userId,
      };
    }

    const minId = `min_${crypto.randomUUID()}`;
    const clientOpId = `tg_draft_${input.externalId}`;
    const membershipRevision = await readMembershipRevision(db, workspaceId);
    const revisionRow = await getWorkspaceRevision(db, workspaceId);
    const expectedRevision = revisionRow?.business_revision ?? 0;
    const replyText = 'Draft marked as sent.';

    const deliveryStmts = await buildTelegramDeliveryInserts(db, {
      workspaceId,
      userId,
      chatId,
      sourceMessageId: minId,
      runId: null,
      kind: 'command',
      key: minId,
      text: replyText,
      target: {
        botInstallationId: input.botInstallationId,
        telegramUserId: input.telegramUserId,
        telegramChatId: input.telegramChatId,
      },
    });

    const execResult = await executeLedgerCommand(
      db,
      {
        workspace_id: workspaceId,
        action_id: `act_${clientOpId}`,
        expected_business_revision: expectedRevision,
        actor: { kind: 'member', user_id: userId },
        membership_revision: membershipRevision,
        request_id: `tg-draft-${draftId}`,
        source_channel: 'telegram',
        source_message_id: minId,
        chat_id: chatId,
      },
      'mark_message_sent',
      { draft_id: draftId, confirmed_by_user_id: userId },
      DEFAULT_COMMAND_HANDLERS['mark_message_sent']!,
      [
        db
          .prepare(
            `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, created_at, updated_at)
             VALUES (?, ?, ?, 'telegram', ?, ?, ?, 'processed', NULL, ?, ?, ?)`,
          )
          .bind(minId, workspaceId, userId, input.externalId, input.fingerprint, input.persistedPayload, chatId, input.now, input.now),
        db
          .prepare(
            `INSERT INTO chat_messages (id, workspace_id, chat_id, author_kind, channel, content_text, run_id, sequence, created_at, updated_at)
             SELECT ?, ?, ?, 'system', 'system', ?, NULL, COALESCE(MAX(sequence), 0) + 1, ?, ? FROM chat_messages WHERE chat_id = ?`,
          )
          .bind(`msg_${crypto.randomUUID()}`, workspaceId, chatId, replyText, input.now, input.now, chatId),
        db
          .prepare(`UPDATE chats SET activity_cursor = activity_cursor + 1, last_activity_at = ?, updated_at = ? WHERE id = ?`)
          .bind(input.now, input.now, chatId),
        ...deliveryStmts,
      ],
      { deferRunTransition: true, extrasBeforeGuard: true },
    );

    if (execResult.status !== 'applied' && execResult.status !== 'already_applied') {
      return { status: 'ignored', reason: 'Failed to mark draft sent' };
    }

    if (botToken) {
      await answerCallbackQuery(botToken, callbackQueryId, 'Draft marked as sent', false, adminTransport).catch(() => null);
      if (input.telegramMessageId) {
        await editTelegramMessageReplyMarkup(botToken, input.telegramChatId, input.telegramMessageId, { inline_keyboard: [] }, adminTransport).catch(() => null);
      }
    }

    return {
      status: 'accepted',
      workspace_id: workspaceId,
      user_id: userId,
    };
  }

  // Action F: cb:export:xlsx or cb:export:json
  if (callbackData === 'cb:export:xlsx' || callbackData === 'cb:export:json') {
    if (botToken) {
      await answerCallbackQuery(botToken, callbackQueryId, 'Preparing export file...', false, adminTransport).catch(() => null);
    }

    const ws = await db
      .prepare(`SELECT id, name FROM workspaces WHERE id = ?`)
      .bind(workspaceId)
      .first<{ id: string; name: string }>();
    const wsName = ws?.name ?? 'Workspace';
    const exportedAt = input.now;

    const sections = await collectWorkspaceExportSections(db, workspaceId);

    if (callbackData === 'cb:export:xlsx') {
      const { sheets, filename } = workspaceExportToSheets(sections, wsName, workspaceId, exportedAt);
      const { buildWorkbook } = await import('@otis/sheet');
      const workbook = buildWorkbook(sheets, filename);

      if (botToken) {
        await sendTelegramDocument(
          botToken,
          input.telegramChatId,
          workbook.bytes,
          workbook.filename,
          workbook.contentType,
          `📊 Excel snapshot for ${wsName} (${exportedAt.slice(0, 10)}).`,
          undefined,
          adminTransport,
        ).catch(() => null);
      }
    } else {
      const document = {
        version: 1,
        workspace: { id: workspaceId, name: wsName, exported_at: exportedAt, exported_by: userId },
        users: sections.users,
        memberships: sections.memberships,
        workspace_settings: sections.settings[0] ?? null,
        chats: sections.chats,
        messages_in: sections.messagesIn,
        chat_messages: sections.chatMessages,
        agent_runs: sections.agentRuns,
        run_steps: sections.runSteps,
        run_activity: sections.runActivity,
        pending_clarifications: sections.pendingClarifications,
        entities: sections.entities,
        entity_aliases: sections.entityAliases,
        entity_state: sections.entityState,
        field_defs: sections.fieldDefs,
        events: sections.events,
        action_receipts: sections.actionReceipts,
        tasks: sections.tasks,
        draft_projections: sections.draftProjections,
        memory_entries: sections.memoryEntries,
        memory_suppressions: sections.memorySuppressions,
        memory_summaries: sections.memorySummaries,
        briefs: sections.briefs,
        brief_items: sections.briefItems,
        reminders: sections.reminders,
        system_jobs: sections.systemJobs,
        outbox: sections.outbox,
        media_objects: [...sections.mediaObjects, ...sections.mediaObjectsV2].map(({ object_key: _key, upload_token_hash: _ticket, upload_token_expires_at: _expiry, ...media }) => ({ ...media, original_url: `/api/workspaces/${encodeURIComponent(workspaceId)}/media/${encodeURIComponent(String(media.id))}` })),
        media_transcriptions: sections.mediaTranscriptions,
        message_image_attachments: sections.messageAttachments,
        interaction_state: sections.interactions ?? [],
        entity_contacts: sections.contacts ?? [],
        entity_redirects: sections.redirects ?? [],
        attachment_links: sections.attachmentLinks ?? [],
        reminder_rules: sections.reminderRules ?? [],
        document_extractions: (sections.documentExtractions ?? []).map(({ result_key: _key, ...extraction }) => extraction),
        media_annotations: sections.mediaAnnotations ?? [],
      };
      const jsonBytes = new TextEncoder().encode(JSON.stringify(document, null, 2));
      const filename = `otis-export-${workspaceId}-${exportedAt.slice(0, 10)}.json`;

      if (botToken) {
        await sendTelegramDocument(
          botToken,
          input.telegramChatId,
          jsonBytes,
          filename,
          'application/json',
          `📦 JSON backup for ${wsName} (${exportedAt.slice(0, 10)}).`,
          undefined,
          adminTransport,
        ).catch(() => null);
      }
    }

    return {
      status: 'accepted',
      workspace_id: workspaceId,
      user_id: userId,
    };
  }

  // Unknown callback query
  if (botToken) {
    await answerCallbackQuery(botToken, callbackQueryId, 'Unrecognized button action', true, adminTransport).catch(() => null);
  }
  return {
    status: 'unsupported',
    reason: `Unknown callback query action: ${callbackData}`,
  };
}

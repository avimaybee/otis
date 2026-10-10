/**
 * Telegram slash-command execution (009A).
 *
 * Commands run through the shared deterministic interpreter
 * (`executeCommand`) with the configured bot username, never through a
 * model. Effects apply to scoped rows only: chat model/thinking overrides
 * stay on the author's chat, workspace selection stays on the Telegram
 * identity (web selection and teammates untouched), and undo delegates to
 * the existing ledger target/dependency/revision rules with the Telegram
 * source as provenance.
 *
 * Undo is composed through ONE ledger command: the source receipt, command
 * run, reply bubble, activity and delivery statements are passed as the
 * ledger command's extra statements, so a true-tail failure rolls back the
 * business undo too, and the events carry the real `source_message_id`.
 * Non-undo commands persist their source/run/reply/delivery in one guarded
 * batch. No provider call happens anywhere here.
 */

import {
  computeUndoPreview,
  executeLedgerCommand,
  getWorkspaceActions,
  getWorkspaceEvents,
  getWorkspaceProjectionState,
  getWorkspaceRevision,
  handleUndoCommit as commitLedgerUndo,
} from '@otis/ledger';
import { parseCommandText } from '@otis/commands';
import type { TelegramReplyMarkup } from '@otis/channels';
import { executeCommand } from '../routes/commands.js';
import type { PlatformKeys } from '../providers/service.js';
import { getChat } from './repository.js';
import { buildTelegramDeliveryStatements } from './telegramDelivery.js';

export interface TelegramCommandInput {
  /** Null when no workspace is resolved yet: only /workspace listing runs. */
  workspaceId: string | null;
  userId: string;
  telegramUserId: string;
  telegramChatId: string;
  botInstallationId: string;
  chatId: string | null;
  sourceMessageId: string;
  externalId: string;
  platformKeys?: PlatformKeys;
  /** Update fingerprint from the inbox (same scheme as ordinary acceptance). */
  fingerprint: string;
  /** Redacted raw update, wrapped with command metadata for replay/target resolution. */
  persistedPayload: string;
  /** Stable per update: `tg:${externalId}`. */
  clientOperationId: string;
  text: string;
  botUsername?: string;
  nowIso?: string;
  requestId: string;
}

export interface TelegramCommandOutcome {
  /** False when this is not a command (or not one we can run here): the
   * caller falls through to reply mapping or ordinary acceptance. */
  handled: boolean;
  reply?: string;
  workspaceId?: string | null;
}

async function readMembershipRevision(db: D1Database, workspaceId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT membership_revision FROM workspaces WHERE id = ?`)
    .bind(workspaceId)
    .first<{ membership_revision: number }>();
  return Number(row?.membership_revision ?? 0);
}

/**
 * /workspace before any workspace is resolved: list memberships, or adopt
 * an exact unambiguous match. Never requires a model and never silently
 * selects the first of several.
 */
async function resolveWorkspaceSelection(
  db: D1Database,
  input: Pick<TelegramCommandInput, 'userId' | 'telegramUserId' | 'text' | 'botUsername' | 'nowIso'>,
): Promise<{ reply: string; workspaceId: string | null }> {
  const now = input.nowIso ?? new Date().toISOString();
  const parsed = parseCommandText(input.text, 'telegram', input.botUsername);
  const rows = (
    await db
      .prepare(
        `SELECT w.id, w.name FROM workspaces w
         JOIN workspace_users wu ON wu.workspace_id = w.id
         WHERE wu.user_id = ? ORDER BY w.name ASC`,
      )
      .bind(input.userId)
      .all<{ id: string; name: string }>()
  ).results ?? [];
  if (parsed.kind !== 'command' || parsed.name !== 'workspace') {
    return { reply: '', workspaceId: null };
  }
  if (parsed.args.length === 0) {
    if (rows.length === 1) {
      await db
        .prepare(`UPDATE telegram_users SET selected_workspace_id = ?, active_chat_id = NULL, updated_at = ? WHERE telegram_user_id = ?`)
        .bind(rows[0]!.id, now, input.telegramUserId)
        .run();
      return { reply: `Using ${rows[0]!.name} for Telegram.`, workspaceId: rows[0]!.id };
    }
    const names = rows.map((row) => row.name).join(', ') || 'none';
    return { reply: `Which workspace should Telegram use? You have: ${names}. Reply /workspace <name>.`, workspaceId: null };
  }
  const requested = parsed.args.join(' ');
  const match = rows.find((row) => row.name.toLowerCase() === requested.toLowerCase() || row.id === requested);
  if (!match) {
    const names = rows.map((row) => row.name).join(', ') || 'none';
    return { reply: `I don't have a workspace called ${requested}. You have: ${names}.`, workspaceId: null };
  }
  await db
    .prepare(`UPDATE telegram_users SET selected_workspace_id = ?, active_chat_id = NULL, updated_at = ? WHERE telegram_user_id = ?`)
    .bind(match.id, now, input.telegramUserId)
    .run();
  return { reply: `Switched to ${match.name}. Past messages stay where they were.`, workspaceId: match.id };
}

interface TelegramUndoInput {
  workspaceId: string;
  userId: string;
  chatId: string;
  clientOperationId: string;
  actionId: string | null;
  mode: 'from_here' | 'single';
}

type TelegramUndoPreparation =
  | { kind: 'reply'; reply: string }
  | {
    kind: 'commit';
    targetActionId: string;
    expectedRevision: number;
    allEvents: Awaited<ReturnType<typeof getWorkspaceEvents>>;
    allActions: Awaited<ReturnType<typeof getWorkspaceActions>>;
  };

/**
 * Read-only undo preparation through the existing ledger target/dependency/
 * revision rules: already-applied, no-target, dependency and empty-preview
 * cases answer without touching the ledger; a valid target returns the
 * snapshot needed for the composed commit.
 */
async function prepareTelegramUndo(
  db: D1Database,
  input: TelegramUndoInput,
): Promise<TelegramUndoPreparation> {
  const undoActionId = `undo_${input.workspaceId}_${input.clientOperationId}`;
  const previous = await db
    .prepare(`SELECT result_json FROM action_receipts WHERE workspace_id = ? AND action_id = ?`)
    .bind(input.workspaceId, undoActionId)
    .first<{ result_json: string }>();
  if (previous) {
    let summary = 'That undo was already applied.';
    try {
      summary = String((JSON.parse(previous.result_json) as { summary?: unknown }).summary ?? summary);
    } catch {
      /* recorded summary stands */
    }
    return { kind: 'reply', reply: summary };
  }

  // Default target: the author's latest reversible action in this chat.
  let targetActionId = input.actionId;
  if (!targetActionId) {
    const recent = await db
      .prepare(
        `SELECT ar.action_id FROM action_receipts ar
         WHERE ar.workspace_id = ? AND ar.actor_user_id = ? AND ar.command_name <> 'undo' AND ar.result_status = 'applied'
           AND ar.source_message_id IN (SELECT id FROM messages_in WHERE chat_id = ?)
           AND EXISTS (SELECT 1 FROM events e WHERE e.workspace_id = ar.workspace_id AND e.action_id = ar.action_id
             AND e.kind <> 'revert'
             AND NOT EXISTS (SELECT 1 FROM events r WHERE r.workspace_id = e.workspace_id AND r.kind = 'revert'
               AND json_extract(r.payload_json, '$.target_event_id') = e.id))
         ORDER BY ar.committed_revision DESC LIMIT 1`,
      )
      .bind(input.workspaceId, input.userId, input.chatId)
      .first<{ action_id: string }>();
    if (!recent) return { kind: 'reply', reply: 'There is no reversible change in this conversation.' };
    targetActionId = recent.action_id;
  }

  const [allEvents, allActions, state, revision] = await Promise.all([
    getWorkspaceEvents(db, input.workspaceId),
    getWorkspaceActions(db, input.workspaceId),
    getWorkspaceProjectionState(db, input.workspaceId),
    getWorkspaceRevision(db, input.workspaceId),
  ]);
  const expectedRevision = revision?.business_revision ?? 0;
  const preview = computeUndoPreview(targetActionId, input.mode, allActions, allEvents, state, expectedRevision);
  if (preview.dependencies.length > 0) {
    const first = preview.dependencies[0]!;
    return { kind: 'reply', reply: `Undo needs clarification first: ${first.reason} Reply with how to proceed.` };
  }
  if (preview.affected_event_ids.length === 0) {
    return { kind: 'reply', reply: 'There is no reversible change in this conversation.' };
  }
  return { kind: 'commit', targetActionId, expectedRevision, allEvents, allActions };
}

/**
 * Executes one Telegram command turn: parse, shared interpretation, scoped
 * effect application, and atomic persistence of the source, command run,
 * reply and delivery rows. Returns handled:false for non-commands (and for
 * commands that need a workspace when none is resolved).
 */
export async function executeTelegramCommand(
  db: D1Database,
  input: TelegramCommandInput,
): Promise<TelegramCommandOutcome> {
  const now = input.nowIso ?? new Date().toISOString();
  const parsed = parseCommandText(input.text, 'telegram', input.botUsername);
  if (parsed.kind === 'text') return { handled: false };

  if (!input.workspaceId) {
    if (parsed.kind === 'command' && parsed.name === 'workspace') {
      const resolved = await resolveWorkspaceSelection(db, input);
      return { handled: true, reply: resolved.reply, workspaceId: resolved.workspaceId };
    }
    return { handled: false };
  }
  const workspaceId = input.workspaceId;

  const chat = input.chatId ? await getChat(db, workspaceId, input.chatId) : null;
  if (!chat) return { handled: false };

  const outcome = await executeCommand(
    { db, workspaceId, userId: input.userId, surface: 'telegram', botUsername: input.botUsername, platformKeys: input.platformKeys },
    chat,
    input.text,
  );
  if (outcome.kind === 'not_a_command') return { handled: false };

  // Dedupe on the update key: a redelivered command replays stored results
  // without re-executing. A conflicting reused key is never a new command.
  const fingerprint = input.fingerprint;
  const existing = await db
    .prepare(`SELECT id, workspace_id, user_id, chat_id, payload_fingerprint, raw_payload FROM messages_in WHERE channel = 'telegram' AND external_id = ?`)
    .bind(input.externalId)
    .first<Record<string, unknown>>();
  if (existing) {
    const matches =
      existing['workspace_id'] === workspaceId &&
      existing['user_id'] === input.userId &&
      existing['chat_id'] === input.chatId &&
      existing['payload_fingerprint'] === fingerprint;
    let storedReply = '';
    try {
      storedReply = String((JSON.parse(String(existing['raw_payload'] ?? '{}')) as { telegram?: { reply?: unknown } }).telegram?.reply ?? '');
    } catch {
      storedReply = '';
    }
    return {
      handled: true,
      reply: matches ? storedReply : 'Already received with different content; the original stands.',
      workspaceId,
    };
  }

  let reply = outcome.kind === 'reply' ? outcome.text : '';
  let selectedWorkspaceId: string | null = null;
  const modelUpdates: Array<{ modelOverride: string | null }> = [];
  const thinkingUpdates: Array<{ thinkingOverride: { model_key: string; choice_id: string } | null }> = [];
  let undoEffect: { actionId: string | null; mode: 'from_here' | 'single' } | null = null;

  for (const effect of outcome.kind === 'reply' ? outcome.effects : []) {
    if (effect.type === 'set_chat_model') {
      modelUpdates.push({ modelOverride: effect.commandKey });
    } else if (effect.type === 'set_chat_thinking') {
      thinkingUpdates.push({ thinkingOverride: effect.thinkingOverride });
    } else if (effect.type === 'set_active_workspace') {
      const target = await db
        .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
        .bind(effect.workspaceId, input.userId)
        .first();
      if (!target) {
        reply = `I could not switch there: you are not a member of that workspace.`;
      } else {
        selectedWorkspaceId = effect.workspaceId;
      }
    } else if (effect.type === 'request_undo') {
      // Composed below into one ledger command so the business undo and the
      // Telegram source/reply/delivery commit or roll back together.
      undoEffect = { actionId: effect.actionId, mode: effect.mode };
    }
  }

  const commandRunId = `run_cmd_${workspaceId}_${input.clientOperationId}`;
  const rawEnvelope = JSON.stringify({
    update: JSON.parse(input.persistedPayload),
    telegram: { result: 'accepted', reply },
  });
  const baseStatements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO acceptance_guards (id, guard_ok) VALUES (?, (SELECT 1 FROM workspace_users wu JOIN chats c ON c.id = ? AND c.workspace_id = wu.workspace_id AND c.author_user_id = wu.user_id WHERE wu.workspace_id = ? AND wu.user_id = ?)) ON CONFLICT(id) DO UPDATE SET guard_ok = excluded.guard_ok`).bind(
      `guard_tg_cmd_${workspaceId}`, input.chatId, workspaceId, input.userId,
    ),
    db
      .prepare(
        `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, created_at, updated_at)
         VALUES (?, ?, ?, 'telegram', ?, ?, ?, 'processed', NULL, ?, ?, ?)`,
      )
      .bind(
        input.sourceMessageId, workspaceId, input.userId, input.externalId, fingerprint, rawEnvelope,
        input.chatId, now, now,
      ),
    db
      .prepare(
        `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, executor_kind, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'command', 'succeeded', ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(commandRunId, workspaceId, input.chatId, input.sourceMessageId, now, now),
    db
      .prepare(
        `INSERT INTO chat_messages (id, workspace_id, chat_id, author_user_id, author_kind, channel, inbound_message_id, client_message_id, content_text, media_id, run_id, sequence, created_at, updated_at)
         SELECT ?, ?, ?, ?, 'member', 'telegram', ?, ?, ?, NULL, ?, COALESCE(MAX(sequence), 0) + 1, ?, ? FROM chat_messages WHERE chat_id = ?`,
      )
      .bind(
        `msg_${crypto.randomUUID()}`, workspaceId, input.chatId, input.userId, input.sourceMessageId,
        input.externalId, input.text, commandRunId, now, now, input.chatId,
      ),
    db
      .prepare(`UPDATE chats SET activity_cursor = activity_cursor + 1, last_activity_at = ?, updated_at = ? WHERE id = ?`)
      .bind(now, now, input.chatId),
  ];
  for (const update of modelUpdates) {
    baseStatements.push(
      db.prepare(`UPDATE chats SET model_override = ?, updated_at = ? WHERE id = ?`).bind(update.modelOverride, now, input.chatId),
    );
  }
  for (const update of thinkingUpdates) {
    baseStatements.push(
      db.prepare(`UPDATE chats SET thinking_override_json = ?, updated_at = ? WHERE id = ?`).bind(
        update.thinkingOverride ? JSON.stringify(update.thinkingOverride) : null, now, input.chatId,
      ),
    );
  }
  if (selectedWorkspaceId) {
    baseStatements.push(
      db.prepare(`INSERT INTO acceptance_guards (id, guard_ok) VALUES (?, (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?)) ON CONFLICT(id) DO UPDATE SET guard_ok = excluded.guard_ok`).bind(
        `guard_tg_ws_${selectedWorkspaceId}`, selectedWorkspaceId, input.userId,
      ),
      db
        .prepare(`UPDATE telegram_users SET selected_workspace_id = ?, active_chat_id = NULL, updated_at = ? WHERE telegram_user_id = ?`)
        .bind(selectedWorkspaceId, now, input.telegramUserId),
    );
  }

  const deliveryStatements = (replyText: string, replyMarkup?: TelegramReplyMarkup | null) =>
    buildTelegramDeliveryStatements(db, {
      workspaceId,
      userId: input.userId,
      chatId: input.chatId!,
      sourceMessageId: input.sourceMessageId,
      runId: commandRunId,
      kind: 'command',
      key: input.sourceMessageId,
      text: replyText,
      replyMarkup,
      // The source row is written in this same batch: resolution reads would
      // not see it, so routing is supplied explicitly from the normalized
      // private update the caller already verified.
      target: {
        botInstallationId: input.botInstallationId,
        telegramUserId: input.telegramUserId,
        telegramChatId: input.telegramChatId,
      },
    });

  const appendReplyActivity = (batch: D1PreparedStatement[], replyText: string) => {
    batch.push(
      db
        .prepare(
          `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
           SELECT ?, ?, ?, ?, activity_cursor, 'answer_saved', ?, ? FROM chats WHERE id = ?`,
        )
        .bind(
          `act_${crypto.randomUUID()}`, workspaceId, input.chatId, commandRunId,
          JSON.stringify({ reply: replyText, selected_workspace_id: selectedWorkspaceId }), now, input.chatId,
        ),
    );
  };

  const runCommandBatch = async (batch: D1PreparedStatement[]): Promise<TelegramCommandOutcome | null> => {
    try {
      await db.batch(batch);
      return null;
    } catch (err) {
      // Concurrent duplicate delivery: reread and verify the persisted record
      // instead of failing indefinitely; genuine storage failures propagate.
      const raced = await db
        .prepare(`SELECT workspace_id, user_id, chat_id, payload_fingerprint, raw_payload FROM messages_in WHERE channel = 'telegram' AND external_id = ?`)
        .bind(input.externalId)
        .first<Record<string, unknown>>();
      if (
        raced &&
        raced['workspace_id'] === workspaceId &&
        raced['user_id'] === input.userId &&
        raced['chat_id'] === input.chatId &&
        raced['payload_fingerprint'] === fingerprint
      ) {
        let storedReply = '';
        try {
          storedReply = String((JSON.parse(String(raced['raw_payload'] ?? '{}')) as { telegram?: { reply?: unknown } }).telegram?.reply ?? '');
        } catch {
          storedReply = '';
        }
        return { handled: true, reply: storedReply, workspaceId };
      }
      throw err;
    }
  };

  if (undoEffect) {
    const prepared = await prepareTelegramUndo(db, {
      workspaceId,
      userId: input.userId,
      chatId: input.chatId!,
      clientOperationId: input.clientOperationId,
      actionId: undoEffect.actionId,
      mode: undoEffect.mode,
    });
    if (prepared.kind === 'commit') {
      const membershipRevision = await readMembershipRevision(db, workspaceId);
      // The callback pushes the undo reply bubble/activity/delivery into the
      // same extra-statement array the ledger command commits, after the
      // base source/run statements. A true-tail failure rolls back the
      // ledger events, source receipt, command run, reply and delivery.
      const composed: D1PreparedStatement[] = [...baseStatements];
      let undoReply = '';
      const result = await executeLedgerCommand(
        db,
        {
          workspace_id: workspaceId,
          action_id: `undo_${workspaceId}_${input.clientOperationId}`,
          expected_business_revision: prepared.expectedRevision,
          actor: { kind: 'member', user_id: input.userId },
          membership_revision: membershipRevision,
          request_id: input.requestId,
          source_channel: 'telegram' as const,
          source_message_id: input.sourceMessageId,
          chat_id: input.chatId!,
        },
        'undo',
        {
          action_id: prepared.targetActionId,
          mode: undoEffect.mode,
          client_operation_id: input.clientOperationId,
          expected_revision: prepared.expectedRevision,
        },
        (ctx, state, seq, req) => {
          const undoOutcome = commitLedgerUndo(ctx, prepared.allEvents, prepared.allActions, state, seq, req);
          undoReply = undoOutcome.result.summary ?? 'Undo applied.';
          composed.push(
            db
              .prepare(
                `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
                 SELECT ?, ?, ?, ?, activity_cursor, 'action_reverted', ?, ? FROM chats WHERE id = ?`,
              )
              .bind(
                `act_${crypto.randomUUID()}`, workspaceId, input.chatId, commandRunId,
                JSON.stringify({ action_id: prepared.targetActionId, mode: undoEffect.mode, requested_by_user_id: input.userId }), now, input.chatId,
              ),
            db.prepare(`INSERT INTO chat_messages (id, workspace_id, chat_id, author_kind, channel, content_text, run_id, sequence, created_at, updated_at) SELECT ?, ?, ?, 'system', 'system', ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ? FROM chat_messages WHERE chat_id = ?`).bind(`msg_${crypto.randomUUID()}`, workspaceId, input.chatId, undoReply, commandRunId, now, now, input.chatId),
            db.prepare(`UPDATE chats SET activity_cursor = activity_cursor + 1 WHERE id = ?`).bind(input.chatId),
            db
              .prepare(
                `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
                 SELECT ?, ?, ?, ?, activity_cursor, 'answer_saved', ?, ? FROM chats WHERE id = ?`,
              )
              .bind(
                `act_${crypto.randomUUID()}`, workspaceId, input.chatId, commandRunId,
                JSON.stringify({ reply: undoReply, selected_workspace_id: null }), now, input.chatId,
              ),
            ...deliveryStatements(undoReply),
          );
          return undoOutcome;
        },
        composed,
        { deferRunTransition: true, extrasBeforeGuard: true },
      );
      if (result.status === 'applied' || result.status === 'already_applied') {
        return { handled: true, reply: undoReply || result.summary || 'Undo applied.', workspaceId };
      }
      // Guard race or rejection: nothing committed. Persist a truthful
      // command reply so the person is answered without a business effect.
      reply = result.summary ?? 'Undo could not be applied; nothing changed.';
    } else {
      reply = prepared.reply;
    }
  }

  const commandReplyMarkup: TelegramReplyMarkup | undefined =
    parsed.kind === 'command' && (parsed.name === 'sheet' || parsed.name === 'export')
      ? {
          inline_keyboard: [
            [
              { text: '📊 Download Excel (.xlsx)', callback_data: 'cb:export:xlsx' },
              { text: '📦 Download JSON', callback_data: 'cb:export:json' },
            ],
          ],
        }
      : undefined;

  const finalStatements = [...baseStatements];
  appendReplyActivity(finalStatements, reply);
  finalStatements.push(...deliveryStatements(reply, commandReplyMarkup));
  const racedOutcome = await runCommandBatch(finalStatements);
  if (racedOutcome) return racedOutcome;
  return { handled: true, reply, workspaceId: selectedWorkspaceId ?? workspaceId };
}

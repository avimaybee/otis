/**
 * @otis/worker/inbox/repository
 * Conversation storage, chats, messages, and atomic message acceptance.
 * In accordance with docs/contracts.md and plans/004-inbound-routing.md.
 */

import type {
  Chat,
  ChatMessage,
  ChatListResponse,
  AcceptMessageResponse,
} from '@otis/contracts';
import { DOMAIN_BOUNDS, STEERING_BOUNDS } from '@otis/contracts';
import { sha256 } from '@otis/identity';
import { PRODUCTION_REGISTRY } from '@otis/agent';
import { resolveModelForChat, resolveVoiceRouteForWorkspace, type PlatformKeys } from '../providers/service.js';
import {
  loadMediaRow,
  markMediaTranscribingStatement,
  mediaValidatedGuardStatement,
  transcriptionIntentStatement,
} from '../media/repository.js';

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class SteeringRunClosedError extends Error {}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Creates a chat authored by the authenticated member.
 */
export async function createChat(
  db: D1Database,
  params: {
    workspaceId: string;
    authorUserId: string;
    title?: string;
    clientChatId?: string;
    modelOverride?: string | null;
  },
): Promise<Chat> {
  if (params.clientChatId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(params.clientChatId)) throw new ValidationError('Invalid client_chat_id.');
  if (params.title !== undefined && (typeof params.title !== 'string' || !params.title.trim() || params.title.length > 200)) throw new ValidationError('title must be 1–200 characters.');
  const now = new Date().toISOString();
  const id = params.clientChatId || `chat_${crypto.randomUUID()}`;
  const title = (params.title || 'New conversation').trim();
  const member = await db.prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`).bind(params.workspaceId, params.authorUserId).first();
  if (!member) throw new NotFoundError('Workspace not found or access denied.');
  const checkExisting = async () => {
    const existing = await getChat(db, params.workspaceId, id);
    if (existing && (existing.author_user_id !== params.authorUserId || existing.title !== title || existing.model_override !== (params.modelOverride || null))) throw new ConflictError('Chat ID already used with different input or author.');
    return existing;
  };
  const existing = await checkExisting(); if (existing) return existing;
  try {
    await db.batch([
      db.prepare(`INSERT INTO acceptance_guards (id, guard_ok) VALUES (?, (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?)) ON CONFLICT(id) DO UPDATE SET guard_ok = excluded.guard_ok`).bind(`guard_chat_${params.workspaceId}`, params.workspaceId, params.authorUserId),
      db.prepare(`INSERT INTO chats (id, workspace_id, author_user_id, title, model_override, is_archived, activity_cursor, created_at, updated_at, last_activity_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`).bind(id, params.workspaceId, params.authorUserId, title, params.modelOverride || null, now, now, now),
    ]);
  } catch (error) {
    const stillMember = await db.prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`).bind(params.workspaceId, params.authorUserId).first();
    if (!stillMember) throw new NotFoundError('Workspace not found or access denied.');
    const raced = await checkExisting(); if (raced) return raced;
    if (params.clientChatId) throw new ConflictError('Chat ID could not be used. Choose a new ID.');
    throw error;
  }

  return {
    id,
    workspace_id: params.workspaceId,
    author_user_id: params.authorUserId,
    title,
    model_override: params.modelOverride || null,
    is_archived: false,
    activity_cursor: 0,
    created_at: now,
    updated_at: now,
    last_activity_at: now,
  };
}

/**
 * Resolves the effective model key and thinking snapshot for a chat exactly
 * as web acceptance does, so Telegram runs pin the same values and a later
 * /model or /thinking cannot change an already accepted run. Pure reads.
 */
export async function resolveThinkingSnapshot(
  db: D1Database,
  params: {
    workspaceId: string;
    chatId: string;
    command?: {
      modelOverride?: string | null;
      thinkingOverride?: { model_key: string; choice_id: string } | null;
    };
  },
): Promise<{ effectiveModelKey: string; thinkingSnapshotJson: string }> {
  const chatRow = await db
    .prepare(
      `SELECT c.model_override, s.default_model, c.thinking_override_json
       FROM chats c
       LEFT JOIN workspace_settings s ON s.workspace_id = c.workspace_id
       WHERE c.id = ? AND c.workspace_id = ?`
    )
    .bind(params.chatId, params.workspaceId)
    .first<{
      model_override: string | null;
      default_model: string | null;
      thinking_override_json: string | null;
    }>();

  let effectiveModelKey = chatRow?.model_override ?? chatRow?.default_model ?? '';
  if (params.command && 'modelOverride' in params.command) {
    effectiveModelKey = params.command.modelOverride ?? chatRow?.default_model ?? '';
  }

  let effectiveThinkingOverride: { model_key: string; choice_id: string } | null = null;
  if (params.command && 'thinkingOverride' in params.command) {
    effectiveThinkingOverride = params.command.thinkingOverride ?? null;
  } else if (chatRow?.thinking_override_json) {
    try {
      const parsed = JSON.parse(chatRow.thinking_override_json);
      if (parsed.model_key === effectiveModelKey) {
        effectiveThinkingOverride = parsed;
      }
    } catch {
      effectiveThinkingOverride = null;
    }
  }

  const entry = PRODUCTION_REGISTRY.entries.find((e) => e.commandKey === effectiveModelKey);
  const choice = entry?.thinking?.choices.find((c) => c.id === effectiveThinkingOverride?.choice_id);
  const thinkingSnapshot = (entry && choice)
    ? {
        version: 1,
        model_key: entry.commandKey,
        endpoint_family: entry.endpointFamily,
        choice_id: choice.id,
        choice_label: choice.label,
        request: choice.request,
        evidence_ref: choice.evidenceRef ?? null,
      }
    : {
        version: 1,
        model_key: effectiveModelKey,
        endpoint_family: entry?.endpointFamily ?? 'gemini-interactions',
        choice_id: 'default',
        choice_label: 'Provider default',
        request: { kind: 'provider_default' },
      };
  return { effectiveModelKey, thinkingSnapshotJson: JSON.stringify(thinkingSnapshot) };
}

/**
 * Gets a chat by ID within a specific workspace.
 */
export async function getChat(
  db: D1Database,
  workspaceId: string,
  chatId: string,
): Promise<Chat | null> {
  const row = await db
    .prepare(
      `SELECT id, workspace_id, author_user_id, (SELECT display_name FROM users WHERE users.id = chats.author_user_id) AS author_display_name, title, model_override, thinking_override_json, is_archived, activity_cursor, created_at, updated_at, last_activity_at
       FROM chats WHERE id = ? AND workspace_id = ?`
    )
    .bind(chatId, workspaceId)
    .first<Record<string, unknown>>();

  if (!row) return null;

  let thinkingOverride: { model_key: string; choice_id: string } | null = null;
  if (row['thinking_override_json']) {
    try {
      thinkingOverride = JSON.parse(String(row['thinking_override_json']));
    } catch {
      thinkingOverride = null;
    }
  }

  return {
    id: String(row['id']),
    workspace_id: String(row['workspace_id']),
    author_user_id: String(row['author_user_id']),
    author_display_name: row['author_display_name'] ? String(row['author_display_name']) : null,
    title: String(row['title']),
    model_override: row['model_override'] ? String(row['model_override']) : null,
    thinking_override: thinkingOverride,
    thinking_override_json: row['thinking_override_json'] ? String(row['thinking_override_json']) : null,
    is_archived: Boolean(row['is_archived']),
    activity_cursor: Number(row['activity_cursor']),
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at']),
    last_activity_at: String(row['last_activity_at']),
  };
}

interface ChatCursor {
  t: string;
  id: string;
}

function encodeChatCursor(c: ChatCursor): string {
  return btoa(JSON.stringify(c));
}

function decodeChatCursor(str?: string): ChatCursor | null {
  if (!str) return null;
  try {
    const parsed: unknown = JSON.parse(atob(str));
    if (parsed && typeof parsed === 'object' && 't' in parsed && 'id' in parsed && typeof parsed.t === 'string' && Number.isFinite(Date.parse(parsed.t)) && typeof parsed.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(parsed.id)) return { t: parsed.t, id: parsed.id };
  } catch { /* invalid cursors must never broaden the read */ }
  throw new ValidationError('Invalid chat cursor.');
}

/**
 * Lists chats in a workspace with optional author filter ('mine' vs 'team') and stable cursor pagination.
 */
export async function listChats(
  db: D1Database,
  workspaceId: string,
  options: {
    filter?: 'mine' | 'team';
    userId?: string;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<ChatListResponse> {
  const limit = Math.min(options.limit || 25, 100);
  let query = `SELECT id, workspace_id, author_user_id, (SELECT display_name FROM users WHERE users.id = chats.author_user_id) AS author_display_name, title, model_override, thinking_override_json, is_archived, activity_cursor, created_at, updated_at, last_activity_at
               FROM chats WHERE workspace_id = ?`;
  const binds: (string | number)[] = [workspaceId];

  if (options.filter === 'mine' && options.userId) {
    query += ` AND author_user_id = ?`;
    binds.push(options.userId);
  }

  const parsedCursor = decodeChatCursor(options.cursor);
  if (parsedCursor) {
    if (parsedCursor.id) {
      query += ` AND (last_activity_at < ? OR (last_activity_at = ? AND id < ?))`;
      binds.push(parsedCursor.t, parsedCursor.t, parsedCursor.id);
    } else {
      query += ` AND last_activity_at < ?`;
      binds.push(parsedCursor.t);
    }
  }

  query += ` ORDER BY last_activity_at DESC, id DESC LIMIT ?`;
  binds.push(limit + 1);

  const stmt = db.prepare(query);
  const rows = (await stmt.bind(...binds).all<Record<string, unknown>>()).results || [];

  let nextCursor: string | undefined;
  if (rows.length > limit) {
    // Remove the extra probe row from the current page's results
    rows.pop();
    // Build nextCursor using the LAST RETURNED item
    const lastReturned = rows[rows.length - 1];
    if (lastReturned) {
      nextCursor = encodeChatCursor({
        t: String(lastReturned['last_activity_at']),
        id: String(lastReturned['id']),
      });
    }
  }

  const chats: Chat[] = rows.map((row) => {
    let thinkingOverride: { model_key: string; choice_id: string } | null = null;
    if (row['thinking_override_json']) {
      try {
        thinkingOverride = JSON.parse(String(row['thinking_override_json']));
      } catch {
        thinkingOverride = null;
      }
    }
    return {
      id: String(row['id']),
      workspace_id: String(row['workspace_id']),
      author_user_id: String(row['author_user_id']),
      author_display_name: row['author_display_name'] ? String(row['author_display_name']) : null,
      title: String(row['title']),
      model_override: row['model_override'] ? String(row['model_override']) : null,
      thinking_override: thinkingOverride,
      thinking_override_json: row['thinking_override_json'] ? String(row['thinking_override_json']) : null,
      is_archived: Boolean(row['is_archived']),
      activity_cursor: Number(row['activity_cursor']),
      created_at: String(row['created_at']),
      updated_at: String(row['updated_at']),
      last_activity_at: String(row['last_activity_at']),
    };
  });

  return {
    chats,
    next_cursor: nextCursor,
  };
}

/**
 * Lists messages for a given chat, ordered by monotonic sequence.
 */
export async function listChatMessages(
  db: D1Database,
  workspaceId: string,
  chatId: string,
  options: {
    beforeSeq?: number;
    limit?: number;
  } = {},
): Promise<ChatMessage[]> {
  const limit = Math.min(options.limit || 50, DOMAIN_BOUNDS.MAX_TRANSCRIPT_PAGE);

  let query = `SELECT id, workspace_id, chat_id, author_user_id, (SELECT display_name FROM users WHERE users.id = chat_messages.author_user_id) AS author_display_name, author_kind, channel, inbound_message_id, client_message_id, content_text, media_id, run_id, sequence, created_at, updated_at
               FROM chat_messages WHERE workspace_id = ? AND chat_id = ?`;
  const binds: (string | number)[] = [workspaceId, chatId];

  if (options.beforeSeq !== undefined) {
    query += ` AND sequence < ?`;
    binds.push(options.beforeSeq);
  }

  query += ` ORDER BY sequence DESC LIMIT ?`;
  binds.push(limit);

  const rows = (await db.prepare(query).bind(...binds).all<Record<string, unknown>>()).results || [];

  return rows.reverse().map((r) => ({
    id: String(r['id']),
    workspace_id: String(r['workspace_id']),
    chat_id: String(r['chat_id']),
    author_user_id: r['author_user_id'] ? String(r['author_user_id']) : null,
    author_display_name: r['author_display_name'] ? String(r['author_display_name']) : null,
    author_kind: r['author_kind'] as 'member' | 'system',
    channel: r['channel'] as 'web' | 'telegram' | 'system',
    inbound_message_id: r['inbound_message_id'] ? String(r['inbound_message_id']) : null,
    client_message_id: r['client_message_id'] ? String(r['client_message_id']) : null,
    content_text: String(r['content_text']),
    media_id: r['media_id'] ? String(r['media_id']) : null,
    run_id: r['run_id'] ? String(r['run_id']) : null,
    sequence: Number(r['sequence']),
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at']),
  }));
}

/**
 * Web Durable Acceptance.
 * In one transaction:
 * - Checks deduplication (same UUID with same payload returns recorded IDs, conflicting UUID returns 409)
 * - Verifies author permission (only the chat author may append)
 * - Allocates monotonic workspace acceptance sequence and chat activity cursor atomically
 * - Persists message_in, chat_message, agent_run, run_activity, and outbox
 * Returns 202 stable IDs.
 */
export async function acceptWebMessage(
  db: D1Database,
  params: {
    workspaceId: string;
    chatId: string;
    userId: string;
    clientMessageId: string;
    text?: string;
    mediaId?: string;
    /** Command completion is committed with acceptance, using the same dedupe/guard path. */
    command?: {
      reply: string;
      /** Audited UI action; it must not become a conversational message. */
      presentation?: 'control';
      applied?: boolean;
      selectedWorkspaceId?: string;
      modelOverride?: string | null;
      thinkingOverride?: { model_key: string; choice_id: string } | null;
    };
    /** An explicitly targeted answer belongs to its original waiting run. */
    answerRunId?: string;
    steerRunId?: string;
    answerContext?: { clarificationId: string; fields?: Record<string, unknown> };
    platformKeys?: PlatformKeys;
  },
): Promise<AcceptMessageResponse> {
  const text = (params.text || '').trim();
  const mediaId = params.mediaId || null;

  if (!text && !mediaId) {
    throw new ValidationError('Message must contain text or a media attachment.');
  }

  if (text.length > DOMAIN_BOUNDS.MAX_INPUT_CHARS) {
    throw new ValidationError(
      `Message length ${text.length} exceeds limit of ${DOMAIN_BOUNDS.MAX_INPUT_CHARS} characters.`,
    );
  }

  // Calculate canonical payload fingerprint
  const canonicalPayload = JSON.stringify({
    text,
    media_id: mediaId,
    ...(params.command?.presentation === 'control' ? { presentation: 'control' } : {}),
    ...(params.answerContext ? { answer: params.answerContext } : {}),
  });
  const fingerprint = await sha256(canonicalPayload);

  const member = await db.prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`).bind(params.workspaceId, params.userId).first();
  if (!member) throw new ForbiddenError('User is no longer an active member of this workspace.');
  const authorChat = await getChat(db, params.workspaceId, params.chatId);
  if (!authorChat) throw new NotFoundError('Chat not found in this workspace.');
  if (authorChat.author_user_id !== params.userId) throw new ForbiddenError('Only the chat author can append messages to this conversation.');

  // Voice attachment: the recording must be the caller's validated private
  // object for this chat, and the route is snapshotted now. A steering voice
  // note would attach to a run that is already executing, so it is refused
  // until the active turn finishes.
  let mediaContext: {
    mediaId: string;
    format: 'audio/webm' | 'audio/mp4' | 'audio/ogg';
    route: 'native' | 'groq_stt';
    sttModel: string | null;
  } | null = null;
  if (mediaId) {
    if (params.steerRunId) {
      throw new ValidationError('Voice notes cannot be added to a running turn yet. Wait for it to finish, then send the recording.');
    }
    const media = await loadMediaRow(db, params.workspaceId, mediaId);
    if (
      !media ||
      media.chat_id !== params.chatId ||
      media.uploader_user_id !== params.userId ||
      // Claimed uploads are bound to their stable message UUID; media
      // ingested by the server from a channel (Telegram) has no client UUID.
      (media.client_message_id !== null && media.client_message_id !== params.clientMessageId)
    ) {
      throw new ValidationError('The voice recording is not available for this message.');
    }
    if (media.state !== 'validated') {
      throw new ValidationError('The voice recording is not ready to send.');
    }
    if (media.expires_at <= new Date().toISOString()) {
      throw new ValidationError('The voice recording expired before it was sent.');
    }
    const model = await resolveModelForChat(db, {
      workspaceId: params.workspaceId,
      actorUserId: params.userId,
      chatId: params.chatId,
      platformKeys: params.platformKeys,
    });
    const route = await resolveVoiceRouteForWorkspace(db, {
      workspaceId: params.workspaceId,
      model: model.available ? model.entry : null,
      audioMimeOrExt: media.format ?? media.content_type ?? '',
      platformKeys: params.platformKeys,
    });
    if (route.route === 'unavailable') {
      throw new ValidationError(route.message);
    }
    mediaContext = {
      mediaId,
      format: (media.format ?? 'audio/webm') as 'audio/webm' | 'audio/mp4' | 'audio/ogg',
      route: route.route,
      sttModel: route.route === 'groq_stt' ? route.sttModel : null,
    };
  }

  // 1. Deduplication check on transport key: (channel = 'web', external_id = clientMessageId)
  const existingInbound = await db
    .prepare(
      `SELECT id, workspace_id, user_id, chat_id, payload_fingerprint, acceptance_sequence
       FROM messages_in WHERE channel = 'web' AND external_id = ?`
    )
    .bind(params.clientMessageId)
    .first<Record<string, unknown>>();

  if (existingInbound) {
    // Check if it's the exact same caller, workspace, chat, and payload
    const matches =
      existingInbound['workspace_id'] === params.workspaceId &&
      existingInbound['user_id'] === params.userId &&
      existingInbound['chat_id'] === params.chatId &&
      existingInbound['payload_fingerprint'] === fingerprint;

    if (matches) {
      // Find linked chat_message and agent_run to return recorded stable IDs
      const inboundId = String(existingInbound['id']);
      const linkedMsg = await db
        .prepare(`SELECT id FROM chat_messages WHERE inbound_message_id = ?`)
        .bind(inboundId)
        .first<{ id: string }>();

      let linkedRun = await db
        .prepare(`SELECT run_id AS id FROM chat_messages WHERE inbound_message_id = ?`)
        .bind(inboundId)
        .first<{ id: string }>();
      if (!linkedRun && params.command?.presentation === 'control') linkedRun = await db.prepare(`SELECT id FROM agent_runs WHERE source_message_id = ? AND workspace_id = ? AND chat_id = ? AND executor_kind = 'command'`).bind(inboundId, params.workspaceId, params.chatId).first<{ id: string }>();

      const steering = linkedMsg ? await db.prepare(`SELECT 1 FROM run_activity WHERE workspace_id = ? AND run_id = ? AND type = 'message_accepted' AND json_extract(payload_json, '$.steering_message_id') = ?`).bind(params.workspaceId, linkedRun?.id ?? '', linkedMsg.id).first() : null;

      return {
        status: 'accepted',
        message_id: linkedMsg ? linkedMsg.id : params.command?.presentation === 'control' ? inboundId : '',
        run_id: linkedRun ? linkedRun.id : '',
        mode: steering ? 'steer' : params.answerContext ? 'clarification' : 'new_run',
        acceptance_sequence: Number(existingInbound['acceptance_sequence']),
      };
    }

    // Conflicting reuse of clientMessageId
    throw new ConflictError(
      'Client message ID already used with different payload or context.',
    );
  }

  // 2. Validate Chat & Author permission
  const chat = await getChat(db, params.workspaceId, params.chatId);
  if (!chat) {
    throw new NotFoundError('Chat not found in this workspace.');
  }

  if (chat.author_user_id !== params.userId) {
    throw new ForbiddenError('Only the chat author can append messages to this conversation.');
  }

  const readSteeringSize = () => db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(cm.content_text)), 0) AS chars FROM chat_messages cm
    WHERE cm.workspace_id = ? AND cm.run_id = ? AND EXISTS (SELECT 1 FROM run_activity a WHERE a.workspace_id = cm.workspace_id AND a.run_id = cm.run_id AND a.type = 'message_accepted' AND json_extract(a.payload_json, '$.steering_message_id') = cm.id)`)
    .bind(params.workspaceId, params.steerRunId ?? '').first<{ count: number; chars: number }>();
  if (params.steerRunId) {
    const size = await readSteeringSize();
    if ((size?.count ?? 0) >= STEERING_BOUNDS.MAX_MESSAGES_PER_RUN || (size?.chars ?? 0) + text.length > STEERING_BOUNDS.MAX_CHARS_PER_RUN) throw new ValidationError('This run has reached its additional-context limit. Let it finish, then continue in a new turn.');
  }

  // 3. Atomically allocate sequence numbers and persist all records
  const now = new Date().toISOString();
  const messageInId = `min_${crypto.randomUUID()}`;
  const chatMessageId = `msg_${crypto.randomUUID()}`;
  const runId = params.steerRunId ?? params.answerRunId ?? `run_${crypto.randomUUID()}`;
  const outboxId = `out_${crypto.randomUUID()}`;
  const activityId = `act_${crypto.randomUUID()}`;

  const { thinkingSnapshotJson } = await resolveThinkingSnapshot(db, {
    workspaceId: params.workspaceId,
    chatId: params.chatId,
    ...(params.command ? { command: params.command } : {}),
  });

  // Single D1 Batch:
  // Step 0: Transaction Guard (aborts batch if caller is no longer active member or not chat author)
  // Step 1: Update workspace last_acceptance_sequence
  // Step 2: Update chat activity_cursor
  // Step 3: Insert messages_in (reading workspace sequence)
  // Step 4: Insert agent_runs
  // Step 5: Insert chat_messages
  // Step 6: Insert run_activity ('message_accepted')
  // Step 7: Insert outbox for WorkspaceActor
  try {
    await db.batch([
      ...(mediaContext ? [
        mediaValidatedGuardStatement(db, {
          workspaceId: params.workspaceId,
          mediaId: mediaContext.mediaId,
          uploaderUserId: params.userId,
          nowIso: now,
        }),
        markMediaTranscribingStatement(db, {
          workspaceId: params.workspaceId,
          mediaId: mediaContext.mediaId,
          nowIso: now,
        }),
      ] : []),
      ...(params.steerRunId ? [db.prepare(`INSERT INTO acceptance_guards (id, guard_ok) SELECT ?, CASE WHEN COUNT(*) < ? AND COALESCE(SUM(length(cm.content_text)), 0) + ? <= ? THEN 1 ELSE NULL END FROM chat_messages cm WHERE cm.workspace_id = ? AND cm.run_id = ? AND EXISTS (SELECT 1 FROM run_activity a WHERE a.workspace_id = cm.workspace_id AND a.run_id = cm.run_id AND a.type = 'message_accepted' AND json_extract(a.payload_json, '$.steering_message_id') = cm.id) ON CONFLICT(id) DO UPDATE SET guard_ok = excluded.guard_ok`).bind(`guard_steer_b_${params.workspaceId}`, STEERING_BOUNDS.MAX_MESSAGES_PER_RUN, text.length, STEERING_BOUNDS.MAX_CHARS_PER_RUN, params.workspaceId, params.steerRunId)] : []),
      ...(params.steerRunId ? [db.prepare(`INSERT INTO acceptance_guards (id, guard_ok) VALUES (?, (SELECT 1 FROM agent_runs WHERE id = ? AND workspace_id = ? AND chat_id = ? AND executor_kind = 'agent' AND status IN ('running', 'queued') AND COALESCE(json_extract(agent_progress_json, '$.phase'), '') <> 'completed')) ON CONFLICT(id) DO UPDATE SET guard_ok = excluded.guard_ok`).bind(`guard_steer_s_${params.workspaceId}`, params.steerRunId, params.workspaceId, params.chatId)] : []),
      ...(params.command?.selectedWorkspaceId ? [db.prepare(
        `INSERT INTO acceptance_guards (id, guard_ok) VALUES (?,
          (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?))
         ON CONFLICT(id) DO UPDATE SET guard_ok = excluded.guard_ok`,
      ).bind(`guard_cmd_ws_${params.workspaceId}`, params.command.selectedWorkspaceId, params.userId)] : []),
      ...(params.command && 'modelOverride' in params.command ? [db.prepare(
        `UPDATE chats SET model_override = ? WHERE id = ? AND workspace_id = ?`,
      ).bind(params.command.modelOverride ?? null, params.chatId, params.workspaceId)] : []),
      ...(params.command && 'thinkingOverride' in params.command ? [db.prepare(
        `UPDATE chats SET thinking_override_json = ? WHERE id = ? AND workspace_id = ?`,
      ).bind(params.command.thinkingOverride ? JSON.stringify(params.command.thinkingOverride) : null, params.chatId, params.workspaceId)] : []),
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
          `guard_msg_${params.workspaceId}`,
          params.chatId,
          params.workspaceId,
          params.userId,
        ),

      db
        .prepare(
          `UPDATE workspaces SET last_acceptance_sequence = last_acceptance_sequence + 1, updated_at = ? WHERE id = ?`
        )
        .bind(now, params.workspaceId),

      db
        .prepare(
          `UPDATE chats SET activity_cursor = activity_cursor + 1, last_activity_at = ?, updated_at = ? WHERE id = ?`
        )
        .bind(now, now, params.chatId),

      db
        .prepare(
          `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, created_at, updated_at)
           VALUES (?, ?, ?, 'web', ?, ?, ?, 'queued', (SELECT last_acceptance_sequence FROM workspaces WHERE id = ?), ?, ?, ?)`
        )
        .bind(
          messageInId,
          params.workspaceId,
          params.userId,
          params.clientMessageId,
          fingerprint,
          canonicalPayload,
          params.workspaceId,
          params.chatId,
          now,
          now,
        ),

      ...(!params.answerRunId && !params.steerRunId ? [db
        .prepare(
          `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, source_job_id, executor_kind, status, model_key, thinking_snapshot_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?,
             (SELECT COALESCE(c.model_override, s.default_model, '') FROM chats c
               LEFT JOIN workspace_settings s ON s.workspace_id = c.workspace_id WHERE c.id = ?), ?, ?, ?)`
        )
        .bind(runId, params.workspaceId, params.chatId, messageInId,
          params.command ? 'command' : 'agent', params.command ? 'succeeded' : 'queued', params.chatId, thinkingSnapshotJson, now, now)] : []),

      // One logical transcription receipt for the attached recording. The
      // unique media_id makes a replayed acceptance a conflict, never a fork.
      ...(mediaContext ? [transcriptionIntentStatement(db, {
        id: `mtr_${crypto.randomUUID()}`,
        workspaceId: params.workspaceId,
        mediaId: mediaContext.mediaId,
        messageInId,
        runId,
        route: mediaContext.route,
        provider: mediaContext.route === 'groq_stt' ? 'groq' : null,
        model: mediaContext.sttModel,
        format: mediaContext.format,
        languageHint: null,
        nowIso: now,
      })] : []),

      ...(params.command?.presentation !== 'control' ? [db
        .prepare(
          `INSERT INTO chat_messages (id, workspace_id, chat_id, author_user_id, author_kind, channel, inbound_message_id, client_message_id, content_text, media_id, run_id, sequence, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'member', 'web', ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM chat_messages WHERE chat_id = ?), ?, ?)`
        )
        .bind(
          chatMessageId,
          params.workspaceId,
          params.chatId,
          params.userId,
          messageInId,
          params.clientMessageId,
          text,
          mediaId,
          runId,
          params.chatId,
          now,
          now,
        )] : []),

      db
        .prepare(
          `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
           VALUES (?, ?, ?, ?, (SELECT activity_cursor FROM chats WHERE id = ?), 'message_accepted', ?, ?)`
        )
        .bind(
          activityId,
          params.workspaceId,
          params.chatId,
          runId,
          params.chatId,
          JSON.stringify({ client_message_id: params.clientMessageId, text, media_id: mediaId, ...(params.command?.presentation === 'control' ? { presentation: 'control' } : {}), ...(params.steerRunId ? { steering_message_id: chatMessageId } : {}) }),
          now,
        ),

      ...(!params.command && !params.answerRunId && !params.steerRunId ? [db
        .prepare(
          `INSERT INTO outbox (id, workspace_id, destination, topic, payload_json, status, created_at, updated_at)
           VALUES (?, ?, 'workspace_actor', 'execute_run', ?, 'pending', ?, ?)`
        )
        .bind(
          outboxId,
          params.workspaceId,
          JSON.stringify({
            run_id: runId,
            chat_id: params.chatId,
            message_id: chatMessageId,
            client_message_id: params.clientMessageId,
          }),
          now,
          now,
        )] : []),
      ...(params.steerRunId ? [db.prepare(`UPDATE messages_in SET status = 'processed' WHERE id = ?`).bind(messageInId)] : []),
      ...(params.command ? [
        db.prepare(`UPDATE messages_in SET status = 'processed' WHERE id = ?`).bind(messageInId),
        ...(params.command.presentation !== 'control' ? [db.prepare(`INSERT INTO chat_messages (id, workspace_id, chat_id, author_user_id, author_kind, channel,
          inbound_message_id, client_message_id, content_text, media_id, run_id, sequence, created_at, updated_at)
          VALUES (?, ?, ?, NULL, 'system', 'system', NULL, NULL, ?, NULL, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM chat_messages WHERE chat_id = ?), ?, ?)`)
          .bind(`msg_${crypto.randomUUID()}`, params.workspaceId, params.chatId, params.command.reply, runId, params.chatId, now, now)] : []),
        db.prepare(`UPDATE chats SET activity_cursor = activity_cursor + 1 WHERE id = ?`).bind(params.chatId),
        db.prepare(`INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
          SELECT ?, ?, ?, ?, activity_cursor, 'answer_saved', ?, ? FROM chats WHERE id = ?`)
          .bind(`act_${crypto.randomUUID()}`, params.workspaceId, params.chatId, runId,
            JSON.stringify({ reply: params.command.reply, selected_workspace_id: params.command.selectedWorkspaceId ?? null, ...(params.command.presentation === 'control' ? { presentation: 'control', command_applied: params.command.applied ?? false } : {}) }), now, params.chatId),
      ] : []),
    ]);
  } catch (err) {
    // If the batch failed, check if membership or chat ownership was violated (late-write rejection)
    const isMember = await db
      .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .bind(params.workspaceId, params.userId)
      .first();
    if (!isMember) {
      throw new ForbiddenError('User is no longer an active member of this workspace.');
    }

    const currentChat = await getChat(db, params.workspaceId, params.chatId);
    if (!currentChat || currentChat.author_user_id !== params.userId) {
      throw new ForbiddenError('Only the chat author can append messages to this conversation.');
    }

    // Concurrent delivery of an identical UUID can lose the unique-index race.
    // Replay through the same scoped fingerprint checks instead of reporting a
    // failure after another request already committed the accepted input.
    const racedInput = await db.prepare(`SELECT id FROM messages_in WHERE channel = 'web' AND external_id = ?`).bind(params.clientMessageId).first();
    if (racedInput) return acceptWebMessage(db, params);

    if (params.steerRunId) {
      const active = await db.prepare(`SELECT 1 FROM agent_runs WHERE id = ? AND workspace_id = ? AND chat_id = ? AND status IN ('queued', 'running') AND COALESCE(json_extract(agent_progress_json, '$.phase'), '') <> 'completed'`).bind(params.steerRunId, params.workspaceId, params.chatId).first();
      if (!active) throw new SteeringRunClosedError('The previous run finished before this message was accepted.');
      const size = await readSteeringSize();
      if ((size?.count ?? 0) >= STEERING_BOUNDS.MAX_MESSAGES_PER_RUN || (size?.chars ?? 0) + text.length > STEERING_BOUNDS.MAX_CHARS_PER_RUN) throw new ValidationError('This run has reached its additional-context limit. Let it finish, then continue in a new turn.');
    }

    throw err;
  }

  // Read back the committed acceptance_sequence directly from THIS message
  const msgRow = await db
    .prepare(`SELECT acceptance_sequence FROM messages_in WHERE id = ?`)
    .bind(messageInId)
    .first<{ acceptance_sequence: number }>();

  const acceptanceSequence = msgRow ? Number(msgRow.acceptance_sequence) : 1;

  return {
    status: 'accepted',
    message_id: params.command?.presentation === 'control' ? messageInId : chatMessageId,
    run_id: runId,
    mode: params.steerRunId ? 'steer' : params.answerRunId ? 'clarification' : 'new_run',
    acceptance_sequence: acceptanceSequence,
  };
}

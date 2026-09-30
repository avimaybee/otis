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
import { DOMAIN_BOUNDS } from '@otis/contracts';
import { sha256 } from '@otis/identity';

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

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
  const now = new Date().toISOString();
  const id = params.clientChatId || `chat_${crypto.randomUUID()}`;
  const title = (params.title || 'New conversation').trim();

  // If clientChatId was provided, check if it already exists (idempotency)
  if (params.clientChatId) {
    const existing = await getChat(db, params.workspaceId, params.clientChatId);
    if (existing) {
      return existing;
    }
  }

  await db
    .prepare(
      `INSERT INTO chats (id, workspace_id, author_user_id, title, model_override, is_archived, activity_cursor, created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
    )
    .bind(
      id,
      params.workspaceId,
      params.authorUserId,
      title,
      params.modelOverride || null,
      now,
      now,
      now,
    )
    .run();

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
 * Gets a chat by ID within a specific workspace.
 */
export async function getChat(
  db: D1Database,
  workspaceId: string,
  chatId: string,
): Promise<Chat | null> {
  const row = await db
    .prepare(
      `SELECT id, workspace_id, author_user_id, title, model_override, is_archived, activity_cursor, created_at, updated_at, last_activity_at
       FROM chats WHERE id = ? AND workspace_id = ?`
    )
    .bind(chatId, workspaceId)
    .first<Record<string, unknown>>();

  if (!row) return null;

  return {
    id: String(row['id']),
    workspace_id: String(row['workspace_id']),
    author_user_id: String(row['author_user_id']),
    title: String(row['title']),
    model_override: row['model_override'] ? String(row['model_override']) : null,
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
    const parsed = JSON.parse(atob(str)) as { t?: string; id?: string };
    if (parsed && typeof parsed.t === 'string' && typeof parsed.id === 'string') {
      return { t: parsed.t, id: parsed.id };
    }
  } catch {
    // Legacy ISO timestamp fallback
    if (str.length > 10) {
      return { t: str, id: '' };
    }
  }
  return null;
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
  let query = `SELECT id, workspace_id, author_user_id, title, model_override, is_archived, activity_cursor, created_at, updated_at, last_activity_at
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

  const chats: Chat[] = rows.map((row) => ({
    id: String(row['id']),
    workspace_id: String(row['workspace_id']),
    author_user_id: String(row['author_user_id']),
    title: String(row['title']),
    model_override: row['model_override'] ? String(row['model_override']) : null,
    is_archived: Boolean(row['is_archived']),
    activity_cursor: Number(row['activity_cursor']),
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at']),
    last_activity_at: String(row['last_activity_at']),
  }));

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

  let query = `SELECT id, workspace_id, chat_id, author_user_id, author_kind, channel, inbound_message_id, client_message_id, content_text, media_id, run_id, sequence, created_at, updated_at
               FROM chat_messages WHERE workspace_id = ? AND chat_id = ?`;
  const binds: (string | number)[] = [workspaceId, chatId];

  if (options.beforeSeq !== undefined) {
    query += ` AND sequence < ?`;
    binds.push(options.beforeSeq);
  }

  query += ` ORDER BY sequence ASC LIMIT ?`;
  binds.push(limit);

  const rows = (await db.prepare(query).bind(...binds).all<Record<string, unknown>>()).results || [];

  return rows.map((r) => ({
    id: String(r['id']),
    workspace_id: String(r['workspace_id']),
    chat_id: String(r['chat_id']),
    author_user_id: r['author_user_id'] ? String(r['author_user_id']) : null,
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
  });
  const fingerprint = await sha256(canonicalPayload);

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

      const linkedRun = await db
        .prepare(`SELECT id FROM agent_runs WHERE source_message_id = ?`)
        .bind(inboundId)
        .first<{ id: string }>();

      return {
        status: 'accepted',
        message_id: linkedMsg ? linkedMsg.id : '',
        run_id: linkedRun ? linkedRun.id : '',
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

  // 3. Atomically allocate sequence numbers and persist all records
  const now = new Date().toISOString();
  const messageInId = `min_${crypto.randomUUID()}`;
  const chatMessageId = `msg_${crypto.randomUUID()}`;
  const runId = `run_${crypto.randomUUID()}`;
  const outboxId = `out_${crypto.randomUUID()}`;
  const activityId = `act_${crypto.randomUUID()}`;

  // Get current max sequence in chat
  const seqRow = await db
    .prepare(`SELECT COALESCE(MAX(sequence), 0) as max_seq FROM chat_messages WHERE chat_id = ?`)
    .bind(params.chatId)
    .first<{ max_seq: number }>();
  const nextMsgSeq = (seqRow?.max_seq || 0) + 1;

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

      db
        .prepare(
          `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, source_job_id, executor_kind, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, 'agent', 'queued', ?, ?)`
        )
        .bind(runId, params.workspaceId, params.chatId, messageInId, now, now),

      db
        .prepare(
          `INSERT INTO chat_messages (id, workspace_id, chat_id, author_user_id, author_kind, channel, inbound_message_id, client_message_id, content_text, media_id, run_id, sequence, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'member', 'web', ?, ?, ?, ?, ?, ?, ?, ?)`
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
          params.workspaceId,
          params.chatId,
          runId,
          params.chatId,
          JSON.stringify({ client_message_id: params.clientMessageId, text, media_id: mediaId }),
          now,
        ),

      db
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
        ),
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
    message_id: chatMessageId,
    run_id: runId,
    acceptance_sequence: acceptanceSequence,
  };
}

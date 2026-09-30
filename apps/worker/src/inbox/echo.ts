/**
 * @otis/worker/inbox/echo
 * Deterministic Echo Test Harness for Gate 004A.
 * Proves durable execution lifecycle, activity cursor progression, and state transitions
 * without calling external AI providers.
 */

export interface EchoResult {
  replyMessageId: string;
  replyText: string;
  chatId: string;
}

export async function executeEchoTurn(
  db: D1Database,
  runId: string,
): Promise<EchoResult> {
  const run = await db
    .prepare(
      `SELECT id, workspace_id, chat_id, source_message_id, status
       FROM agent_runs WHERE id = ?`
    )
    .bind(runId)
    .first<Record<string, unknown>>();

  if (!run) {
    throw new Error(`Run '${runId}' not found.`);
  }

  const workspaceId = String(run['workspace_id']);
  const chatId = String(run['chat_id']);
  const runStatus = String(run['status']);

  // Idempotency: If this run has already succeeded, return the recorded system reply without duplicate turns
  if (runStatus === 'succeeded') {
    const existingReply = await db
      .prepare(
        `SELECT id, content_text FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`
      )
      .bind(runId)
      .first<Record<string, unknown>>();

    if (existingReply) {
      return {
        replyMessageId: String(existingReply['id']),
        replyText: String(existingReply['content_text']),
        chatId,
      };
    }
  }

  if (runStatus !== 'queued') {
    throw new Error(
      `Run '${runId}' cannot be executed because its status is '${runStatus}' (expected 'queued').`,
    );
  }

  const sourceMessageId = run['source_message_id'] ? String(run['source_message_id']) : null;
  if (!sourceMessageId) {
    throw new Error(`Run '${runId}' has no linked source message.`);
  }

  const sourceMsg = await db
    .prepare(
      `SELECT content_text, channel
       FROM chat_messages WHERE run_id = ?`
    )
    .bind(runId)
    .first<Record<string, unknown>>();

  const originalText = sourceMsg ? String(sourceMsg['content_text']) : '';
  const channel = sourceMsg ? String(sourceMsg['channel']) : 'web';
  const replyText = `Echo: ${originalText}`;
  const now = new Date().toISOString();

  const replyMsgId = `msg_${crypto.randomUUID()}`;
  const actChunkId = `act_${crypto.randomUUID()}`;
  const actFinishId = `act_${crypto.randomUUID()}`;

  // Find exact outbox entry for this run to update by primary key (not substring match)
  const outboxRow = await db
    .prepare(
      `SELECT id FROM outbox WHERE workspace_id = ? AND status = 'pending' AND json_extract(payload_json, '$.run_id') = ?`
    )
    .bind(workspaceId, runId)
    .first<{ id: string }>();

  // Next sequence in chat
  const seqRow = await db
    .prepare(`SELECT COALESCE(MAX(sequence), 0) as max_seq FROM chat_messages WHERE chat_id = ?`)
    .bind(chatId)
    .first<{ max_seq: number }>();
  const nextSeq = (seqRow?.max_seq || 0) + 1;

  const batchStatements: D1PreparedStatement[] = [
    // Guard against race conditions: fails batch if run is no longer queued
    db
      .prepare(
        `INSERT INTO acceptance_guards (id, guard_ok)
         VALUES (?, (SELECT 1 FROM agent_runs WHERE id = ? AND status = 'queued'))`,
      )
      .bind(`guard_${crypto.randomUUID()}`, runId),

    db
      .prepare(`UPDATE agent_runs SET status = 'succeeded', updated_at = ? WHERE id = ?`)
      .bind(now, runId),

    db
      .prepare(`UPDATE messages_in SET status = 'processed', updated_at = ? WHERE id = ?`)
      .bind(now, sourceMessageId),

    db
      .prepare(
        `UPDATE chats SET activity_cursor = activity_cursor + 2, last_activity_at = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(now, now, chatId),

    db
      .prepare(
        `INSERT INTO chat_messages (id, workspace_id, chat_id, author_user_id, author_kind, channel, inbound_message_id, client_message_id, content_text, media_id, run_id, sequence, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'system', ?, NULL, NULL, ?, NULL, ?, ?, ?, ?)`,
      )
      .bind(
        replyMsgId,
        workspaceId,
        chatId,
        channel,
        replyText,
        runId,
        nextSeq,
        now,
        now,
      ),

    db
      .prepare(
        `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, (SELECT activity_cursor - 1 FROM chats WHERE id = ?), 'text_chunk', ?, ?)`,
      )
      .bind(
        actChunkId,
        workspaceId,
        chatId,
        runId,
        chatId,
        JSON.stringify({ text: replyText }),
        now,
      ),

    db
      .prepare(
        `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, (SELECT activity_cursor FROM chats WHERE id = ?), 'run_finished', ?, ?)`,
      )
      .bind(
        actFinishId,
        workspaceId,
        chatId,
        runId,
        chatId,
        JSON.stringify({ status: 'succeeded' }),
        now,
      ),
  ];

  if (outboxRow) {
    batchStatements.push(
      db
        .prepare(`UPDATE outbox SET status = 'delivered', updated_at = ? WHERE id = ?`)
        .bind(now, outboxRow.id),
    );
  }

  try {
    await db.batch(batchStatements);
  } catch (err) {
    // If batch failed due to race, check if another invocation succeeded and return its reply
    const currentRun = await db
      .prepare(`SELECT status FROM agent_runs WHERE id = ?`)
      .bind(runId)
      .first<{ status: string }>();

    if (currentRun?.status === 'succeeded') {
      const existingReply = await db
        .prepare(
          `SELECT id, content_text FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`,
        )
        .bind(runId)
        .first<Record<string, unknown>>();

      if (existingReply) {
        return {
          replyMessageId: String(existingReply['id']),
          replyText: String(existingReply['content_text']),
          chatId,
        };
      }
    }

    throw err;
  }

  return {
    replyMessageId: replyMsgId,
    replyText,
    chatId,
  };
}

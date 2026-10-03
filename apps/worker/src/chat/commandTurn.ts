/**
 * Durable command turn records shared by web routes.
 *
 * A slash command is an attributed turn, not a side effect: it owns an inbound
 * message, a `command` run and public activity, so it survives restart and is
 * auditable. UI control actions retain those records without chat bubbles.
 */

import { sha256 } from '@otis/identity';

/**
 * Returns the inbound message for `externalId`, creating it once.
 *
 * `agent_runs` requires exactly one of source_message_id/source_job_id, so a
 * command run must point at a real accepted message.
 */
export async function ensureCommandSourceMessage(
  db: D1Database,
  params: { workspaceId: string; userId: string; chatId: string; externalId: string; text: string; targetActionId: string; mode: string; presentation?: 'control' },
): Promise<{ messageInId: string; created: boolean }> {
  const payload = JSON.stringify({ text: params.text.trim(), media_id: null, ...(params.presentation ? { presentation: params.presentation } : {}) });
  const fingerprint = await sha256(payload);
  const existing = await db.prepare(`SELECT id, workspace_id, user_id, chat_id, payload_fingerprint, raw_payload FROM messages_in WHERE channel = 'web' AND external_id = ?`).bind(params.externalId).first<Record<string, unknown>>();
  if (existing) {
    let saved: { undo_action_id?: string; undo_mode?: string } = {};
    try { saved = JSON.parse(String(existing['raw_payload'])); } catch { /* old input cannot grant a new operation */ }
    if (existing['workspace_id'] !== params.workspaceId || existing['user_id'] !== params.userId || existing['chat_id'] !== params.chatId || existing['payload_fingerprint'] !== fingerprint || saved.undo_action_id !== params.targetActionId || saved.undo_mode !== params.mode) throw new Error('undo_operation_conflict');
    return { messageInId: String(existing['id']), created: false };
  }
  const now = new Date().toISOString(); const id = `min_${crypto.randomUUID()}`;
  await db.batch([
    db.prepare(`INSERT INTO acceptance_guards (id, guard_ok) VALUES (?, (SELECT 1 FROM workspace_users wu JOIN chats c ON c.workspace_id = wu.workspace_id AND c.author_user_id = wu.user_id WHERE wu.workspace_id = ? AND wu.user_id = ? AND c.id = ?))`).bind(`guard_${crypto.randomUUID()}`, params.workspaceId, params.userId, params.chatId),
    db.prepare(`UPDATE workspaces SET last_acceptance_sequence = last_acceptance_sequence + 1 WHERE id = ?`).bind(params.workspaceId),
    db.prepare(`INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, acceptance_sequence, chat_id, created_at, updated_at) VALUES (?, ?, ?, 'web', ?, ?, ?, 'processed', (SELECT last_acceptance_sequence FROM workspaces WHERE id = ?), ?, ?, ?)`).bind(id, params.workspaceId, params.userId, params.externalId, fingerprint, JSON.stringify({ ...JSON.parse(payload), undo_action_id: params.targetActionId, undo_mode: params.mode }), params.workspaceId, params.chatId, now, now),
  ]);
  return { messageInId: id, created: true };
}

/**
 * Creates the `command` executor run for a command turn. The id is derived from
 * the caller's idempotency key so a retry reuses the same run.
 */
export async function ensureCommandRun(
  db: D1Database,
  params: { runId: string; workspaceId: string; chatId: string; sourceMessageId: string },
): Promise<string> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, executor_kind, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'command', 'succeeded', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(params.runId, params.workspaceId, params.chatId, params.sourceMessageId, now, now)
    .run();
  return params.runId;
}

/** Appends one public activity row and advances the chat's activity cursor. */
export async function appendCommandActivity(
  db: D1Database,
  params: {
    workspaceId: string;
    chatId: string;
    runId: string;
    type: 'answer_saved' | 'action_reverted';
    payload: unknown;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(`UPDATE chats SET activity_cursor = activity_cursor + 1, last_activity_at = ?, updated_at = ? WHERE id = ?`)
      .bind(now, now, params.chatId),
    db
      .prepare(
        `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
         SELECT ?, ?, ?, ?, activity_cursor, ?, ?, ? FROM chats WHERE id = ?`,
      )
      .bind(
        `act_${crypto.randomUUID()}`,
        params.workspaceId,
        params.chatId,
        params.runId,
        params.type,
        JSON.stringify(params.payload),
        now,
        params.chatId,
      ),
  ]);
}

import type { PublicActivityType } from '@otis/contracts';
import type { TurnContext } from '../actor/dispatch.js';
import { liveChatBus } from '../chat/liveBus.js';

/** Public activity is durable and broadcast immediately to in-memory listeners. */
export async function publishAgentActivity(
  ctx: TurnContext,
  key: string,
  type: PublicActivityType,
  payload: unknown,
): Promise<void> {
  if (!ctx.chatId) return;
  const id = `act_${ctx.runId}_${key}`;
  const now = new Date().toISOString();

  // One atomic batch: the cursor increment and the insert commit together,
  // and the INSERT returns its cursor directly. Both statements are gated on
  // the idempotent record key, so a retried publish inserts nothing, burns no
  // cursor, and broadcasts nothing — no pre-read and no post-read.
  const [, inserted] = await ctx.db.batch([
    ctx.db.prepare(
      `UPDATE chats SET activity_cursor = activity_cursor + 1, last_activity_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND NOT EXISTS (SELECT 1 FROM run_activity WHERE id = ? AND workspace_id = ?)`
    ).bind(now, now, ctx.chatId, ctx.workspaceId, id, ctx.workspaceId),
    ctx.db.prepare(
      `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
       SELECT ?, ?, ?, ?, activity_cursor, ?, ?, ? FROM chats WHERE id = ? AND workspace_id = ? AND NOT EXISTS (SELECT 1 FROM run_activity WHERE id = ? AND workspace_id = ?)
       RETURNING cursor`
    ).bind(id, ctx.workspaceId, ctx.chatId, ctx.runId, type, JSON.stringify(payload), now, ctx.chatId, ctx.workspaceId, id, ctx.workspaceId),
  ]);
  const rows = (inserted as unknown as { results?: Array<{ cursor: number }> }).results ?? [];
  if (rows.length === 0) {
    return;
  }
  const committedCursor = Number(rows[0]!.cursor);

  // Broadcast in-memory directly to live subscribers with positive persisted cursor and SSE ID (SOL-29)
  liveChatBus.broadcast(ctx.workspaceId, ctx.chatId, {
    name: 'activity',
    id: committedCursor,
    data: {
      schema_version: 1,
      id,
      cursor: committedCursor,
      workspace_id: ctx.workspaceId,
      chat_id: ctx.chatId,
      run_id: ctx.runId,
      created_at: now,
      type,
      payload,
    },
  });
}


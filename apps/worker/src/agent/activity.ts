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

  // Deduplicate before touching D1 or broadcasting (SOL-29 idempotency)
  const existing = await ctx.db
    .prepare(`SELECT cursor FROM run_activity WHERE id = ? AND workspace_id = ?`)
    .bind(id, ctx.workspaceId)
    .first<{ cursor: number }>();
  if (existing) {
    return;
  }

  await ctx.db.batch([
    ctx.db.prepare(
      `UPDATE chats SET activity_cursor = activity_cursor + 1, last_activity_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`
    ).bind(now, now, ctx.chatId, ctx.workspaceId),
    ctx.db.prepare(
      `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
       SELECT ?, ?, ?, ?, activity_cursor, ?, ?, ? FROM chats WHERE id = ? AND workspace_id = ?`
    ).bind(id, ctx.workspaceId, ctx.chatId, ctx.runId, type, JSON.stringify(payload), now, ctx.chatId, ctx.workspaceId),
  ]);

  const committed = await ctx.db
    .prepare(`SELECT cursor FROM run_activity WHERE id = ? AND workspace_id = ?`)
    .bind(id, ctx.workspaceId)
    .first<{ cursor: number }>();
  const committedCursor = Number(committed?.cursor ?? 1);

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


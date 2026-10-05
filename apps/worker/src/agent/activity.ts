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

  await ctx.db.batch([
    ctx.db.prepare(
      `UPDATE chats SET activity_cursor = activity_cursor + 1 WHERE id = ? AND workspace_id = ? AND NOT EXISTS (SELECT 1 FROM run_activity WHERE id = ?)`
    ).bind(ctx.chatId, ctx.workspaceId, id),
    ctx.db.prepare(
      `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at) SELECT ?, ?, ?, ?, activity_cursor, ?, ?, ? FROM chats WHERE id = ? AND workspace_id = ? AND NOT EXISTS (SELECT 1 FROM run_activity WHERE id = ?)`
    ).bind(id, ctx.workspaceId, ctx.chatId, ctx.runId, type, JSON.stringify(payload), now, ctx.chatId, ctx.workspaceId, id),
  ]);

  // Broadcast in-memory directly to live subscribers (zero D1 polling)
  liveChatBus.broadcast(ctx.workspaceId, ctx.chatId, {
    name: 'activity',
    data: {
      schema_version: 1,
      id,
      cursor: 0,
      workspace_id: ctx.workspaceId,
      chat_id: ctx.chatId,
      run_id: ctx.runId,
      created_at: now,
      type,
      payload,
    },
  });
}


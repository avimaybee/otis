import type { PublicActivityType } from '@otis/contracts';
import type { TurnContext } from '../actor/dispatch.js';

/** Public activity is fenced, durable and idempotent before SSE can expose it. */
export async function publishAgentActivity(ctx: TurnContext, key: string, type: PublicActivityType, payload: unknown): Promise<void> {
  if (!ctx.chatId) return;
  const id = `act_${ctx.runId}_${key}`;
  const now = new Date().toISOString();
  await ctx.db.batch([
    ctx.db.prepare(`INSERT INTO acceptance_guards (id, guard_ok) VALUES (?, (SELECT 1 FROM agent_runs r JOIN workspaces w ON w.id = r.workspace_id JOIN messages_in m ON m.id = r.source_message_id JOIN workspace_users wu ON wu.workspace_id = r.workspace_id AND wu.user_id = m.user_id WHERE r.id = ? AND r.workspace_id = ? AND r.chat_id = ? AND r.status = 'running' AND r.attempt_id = ? AND r.lease_fence = ? AND w.lease_owner = ? AND w.lease_attempt_id = ? AND w.lease_fence = ? AND w.lease_expires_at > ?))`).bind(`guard_${crypto.randomUUID()}`, ctx.runId, ctx.workspaceId, ctx.chatId, ctx.attemptId, ctx.fence, ctx.attemptId, ctx.attemptId, ctx.fence, now),
    ctx.db.prepare(`UPDATE chats SET activity_cursor = activity_cursor + 1 WHERE id = ? AND workspace_id = ? AND NOT EXISTS (SELECT 1 FROM run_activity WHERE id = ?)`).bind(ctx.chatId, ctx.workspaceId, id),
    ctx.db.prepare(`INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at) SELECT ?, ?, ?, ?, activity_cursor, ?, ?, ? FROM chats WHERE id = ? AND workspace_id = ? AND NOT EXISTS (SELECT 1 FROM run_activity WHERE id = ?)`).bind(id, ctx.workspaceId, ctx.chatId, ctx.runId, type, JSON.stringify(payload), now, ctx.chatId, ctx.workspaceId, id),
  ]);
}

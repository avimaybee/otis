/**
 * @otis/worker/inbox/echo
 * Deterministic Echo Test Harness, now dispatched through the 004B actor.
 * Same observable contract as the 004A harness (idempotent replay, cursor
 * progression, outbox delivery), but claims, pins, steps, and commits all go
 * through the leased dispatch protocol — there is exactly one commit path.
 */

import { dispatchOutboxItem } from '../actor/dispatch.js';

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
      `SELECT id, workspace_id, chat_id, status FROM agent_runs WHERE id = ?`,
    )
    .bind(runId)
    .first<Record<string, unknown>>();

  if (!run) {
    throw new Error(`Run '${runId}' not found.`);
  }

  const workspaceId = String(run['workspace_id']);
  const chatId = String(run['chat_id']);
  const runStatus = String(run['status']);

  // Idempotency: a succeeded run returns its recorded system reply.
  if (runStatus === 'succeeded') {
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

  if (runStatus !== 'queued') {
    throw new Error(
      `Run '${runId}' cannot be executed because its status is '${runStatus}' (expected 'queued').`,
    );
  }

  // Route through leased dispatch. If acceptance's outbox row is missing
  // (direct harness use), recreate the dispatch intent first — the same
  // backstop recovery applies to orphaned queued runs.
  const now = new Date().toISOString();
  let outbox = await db
    .prepare(
      `SELECT id FROM outbox
       WHERE workspace_id = ? AND status = 'pending' AND json_extract(payload_json, '$.run_id') = ?`,
    )
    .bind(workspaceId, runId)
    .first<{ id: string }>();
  if (!outbox) {
    const outboxId = `out_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO outbox (id, workspace_id, destination, topic, payload_json, status, created_at, updated_at)
         VALUES (?, ?, 'workspace_actor', 'execute_run', ?, 'pending', ?, ?)`,
      )
      .bind(outboxId, workspaceId, JSON.stringify({ run_id: runId }), now, now)
      .run();
    outbox = { id: outboxId };
  }

  const result = await dispatchOutboxItem(db, outbox.id, workspaceId);
  if (result.status === 'completed' || result.status === 'already_done') {
    const reply = await loadSystemReply(db, runId);
    if (reply) return { ...reply, chatId };
  }
  // A lost race still returns the winner's recorded reply, never a duplicate.
  const current = await db
    .prepare(`SELECT status FROM agent_runs WHERE id = ?`)
    .bind(runId)
    .first<{ status: string }>();
  if (current?.status === 'succeeded') {
    const reply = await loadSystemReply(db, runId);
    if (reply) return { ...reply, chatId };
  }
  if (result.status === 'deferred' || result.status === 'contended') {
    throw new Error(`Run '${runId}' could not acquire the workspace lease (${result.detail ?? result.status}).`);
  }
  throw new Error(`Run '${runId}' did not complete (dispatch status '${result.status}').`);
}

async function loadSystemReply(
  db: D1Database,
  runId: string,
): Promise<{ replyMessageId: string; replyText: string } | null> {
  const reply = await db
    .prepare(
      `SELECT id, content_text FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`,
    )
    .bind(runId)
    .first<Record<string, unknown>>();
  if (!reply) return null;
  return { replyMessageId: String(reply['id']), replyText: String(reply['content_text']) };
}
